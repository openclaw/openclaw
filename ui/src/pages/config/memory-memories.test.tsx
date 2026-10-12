/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { MemoryMemories, type MemoryMemoriesProps } from "./memory-memories.tsx";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type MemoryMemoriesTestElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  methodAdvertised: boolean;
  agentId: string | null;
};

function createElement(request: Request, advertised = true) {
  const input: MemoryMemoriesProps = {
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    methodAdvertised: advertised,
    agentId: "main",
  };
  const element = Object.assign(document.createElement("div"), input);
  const [revision, setRevision] = createSignal(0);
  for (const key of ["client", "connected", "methodAdvertised", "agentId"] as const) {
    Object.defineProperty(element, key, {
      get: () => input[key],
      set: (value: unknown) => {
        Object.assign(input, { [key]: value });
        setRevision((current) => current + 1);
      },
    });
  }
  document.body.append(element);
  const { unmount } = mountSolid(
    () => (
      <MemoryMemories
        client={(revision(), input.client)}
        connected={(revision(), input.connected)}
        methodAdvertised={(revision(), input.methodAdvertised)}
        agentId={(revision(), input.agentId)}
      />
    ),
    { container: element },
  );
  const remove = element.remove.bind(element);
  element.remove = () => {
    unmount();
    remove();
  };
  flush();
  return element;
}

function typeQuery(element: MemoryMemoriesTestElement, query: string) {
  flush();
  const input = element.querySelector<HTMLInputElement>("#memory-search-input");
  if (!input) {
    throw new Error("missing memory search input");
  }
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
}

function submit(element: MemoryMemoriesTestElement) {
  element
    .querySelector("form")
    ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

const result = {
  path: "memory/people/ada.md",
  startLine: 2,
  endLine: 3,
  score: 0.876,
  snippet: "Ada prefers careful reviews.",
  source: "memory" as const,
};

function memoryFileResponse(content: string, path = result.path) {
  return {
    agentId: "main",
    file: {
      path,
      name: path.split("/").at(-1),
      size: content.length,
      updatedAtMs: 1,
      mimeType: "text/plain",
      encoding: "utf8",
      content,
    },
  };
}

describe("MemoryMemoriesElement", () => {
  it("renders idle and gateway-update-required states", () => {
    const current = createElement(vi.fn(() => Promise.resolve({})));
    flush();
    expect(current.textContent).toContain("Search for a person, project, decision");
    expect(current.querySelector("form")).not.toBeNull();
    current.remove();

    const old = createElement(
      vi.fn(() => Promise.resolve({})),
      false,
    );
    flush();
    expect(old.textContent).toContain("Update the gateway to search memories");
    expect(old.querySelector("form")).toBeNull();
    old.remove();
  });

  it("keeps search disabled when no agent is available", async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const element = createElement(request);
    try {
      element.agentId = null;
      typeQuery(element, "Ada");
      expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        true,
      );
      submit(element);
      expect(request).not.toHaveBeenCalled();
    } finally {
      element.remove();
    }
  });

  it("renders empty and retryable error states", async () => {
    const request = vi
      .fn<Request>()
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce({
        agentId: "main",
        provider: "none",
        searchMode: "fts-only",
        results: [],
      });
    const element = createElement(request);
    try {
      typeQuery(element, "missing");
      submit(element);
      await waitForSolid(() => expect(element.textContent).toContain("index unavailable"));

      const retry = [...element.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      );
      retry?.click();
      await waitForSolid(() => expect(element.textContent).toContain("No memories matched"));
      expect(element.textContent).toContain("keyword search");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      element.remove();
    }
  });

  it("shares pending and loaded files across matches while keeping each row's highlight", async () => {
    const second = { ...result, startLine: 1, endLine: 1 };
    const third = { ...second, path: "memory/projects/Open Claw.md" };
    const pending = deferred<unknown>();
    const fileResponse = memoryFileResponse("first\nmatched two\nmatched three\nfourth");
    const request = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "memory.search") {
        return Promise.resolve({
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          results: [result, second, third],
        });
      }
      return params.path === result.path
        ? pending.promise
        : Promise.resolve(memoryFileResponse("Another memory file", third.path));
    });
    const element = createElement(request);
    try {
      typeQuery(element, "Ada");
      submit(element);
      await waitForSolid(() => expect(element.querySelectorAll("article")).toHaveLength(3));

      const rows = element.querySelectorAll<HTMLButtonElement>("article > button");
      rows[0]?.click();
      await waitForSolid(() =>
        expect(element.textContent).toContain("Loading the full memory file"),
      );
      rows[1]?.click();
      flush();
      expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
      expect(rows[1]?.getAttribute("aria-expanded")).toBe("true");
      expect(element.querySelectorAll(".memory-memories__detail")).toHaveLength(1);
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(1);

      pending.resolve(fileResponse);
      await waitForSolid(() =>
        expect(element.querySelector('[data-memory-match="true"]')?.textContent).toBe("first"),
      );
      rows[0]?.click();
      flush();
      expect(element.querySelector('[data-memory-match="true"]')?.textContent).toBe(
        "matched two\nmatched three",
      );

      rows[0]?.click();
      rows[0]?.click();
      flush();
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(1);
      expect(request).toHaveBeenCalledWith("agents.workspace.get", {
        agentId: "main",
        path: result.path,
      });

      rows[2]?.click();
      flush();
      expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
      expect(rows[2]?.getAttribute("aria-expanded")).toBe("true");
      expect(rows[2]?.getAttribute("aria-controls")).toBe("memory-detail-2");
      expect(element.querySelector("#memory-detail-2")).not.toBeNull();
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(2);
    } finally {
      element.remove();
    }
  });

  it("keeps session, absolute, and escaping paths non-expandable", async () => {
    const nonExpandable = [
      { ...result, path: "sessions/main/session-1.jsonl", source: "sessions" as const },
      { ...result, path: "sessions/main/mislabeled.jsonl" },
      { ...result, path: "/external/MEMORY.md" },
      { ...result, path: "C:\\external\\MEMORY.md" },
      { ...result, path: "memory/../outside.md" },
    ];
    const request = vi.fn<Request>(() =>
      Promise.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "hybrid",
        results: [{ ...result, path: "MEMORY.md" }, ...nonExpandable],
      }),
    );
    const element = createElement(request);
    try {
      typeQuery(element, "memory");
      submit(element);
      await waitForSolid(() => expect(element.querySelectorAll("article")).toHaveLength(6));

      expect(element.querySelectorAll("article > button")).toHaveLength(1);
      expect(element.querySelectorAll("article > div.settings-row")).toHaveLength(5);
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(0);
    } finally {
      element.remove();
    }
  });

  it("keeps workspace read failures on the expanded row", async () => {
    const request = vi.fn((method: string) =>
      method === "memory.search"
        ? Promise.resolve({
            agentId: "main",
            provider: "local",
            searchMode: "hybrid",
            results: [result],
          })
        : Promise.reject(new Error("workspace file not found")),
    );
    const element = createElement(request);
    try {
      typeQuery(element, "Ada");
      submit(element);
      await waitForSolid(() => expect(element.querySelector("article > button")).not.toBeNull());
      element.querySelector<HTMLButtonElement>("article > button")?.click();

      await waitForSolid(() =>
        expect(element.textContent).toContain(
          "Could not load this memory file: workspace file not found",
        ),
      );
      expect(element.textContent).toContain(result.snippet);
      expect(element.textContent).not.toContain("Memory search failed");
    } finally {
      element.remove();
    }
  });

  it("resets results when the selected agent changes", async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "hybrid",
        results: [result],
      }),
    );
    const element = createElement(request);
    try {
      typeQuery(element, "Ada");
      submit(element);
      await waitForSolid(() => expect(element.textContent).toContain(result.snippet));

      element.agentId = "research";
      await waitForSolid(() => expect(element.textContent).toContain("Search for a person"));
      expect(element.textContent).not.toContain(result.snippet);
      expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("");
    } finally {
      element.remove();
    }
  });

  it.each(["resolves", "rejects"] as const)(
    "keeps the current file read when an earlier search's read %s",
    async (outcome) => {
      const previous = deferred<unknown>();
      const current = deferred<unknown>();
      let fileReads = 0;
      const request = vi.fn((method: string) => {
        if (method === "memory.search") {
          return Promise.resolve({
            agentId: "main",
            provider: "local",
            searchMode: "hybrid",
            results: [result],
          });
        }
        return fileReads++ === 0 ? previous.promise : current.promise;
      });
      const element = createElement(request);
      try {
        for (const query of ["Ada", "Ada again"]) {
          typeQuery(element, query);
          submit(element);
          flush();
          await waitForSolid(() =>
            expect(element.querySelector("article > button")).not.toBeNull(),
          );
          element.querySelector<HTMLButtonElement>("article > button")?.click();
          await waitForSolid(() =>
            expect(element.textContent).toContain("Loading the full memory file"),
          );
        }
        expect(fileReads).toBe(2);

        if (outcome === "resolves") {
          previous.resolve(memoryFileResponse("Retired content"));
        } else {
          previous.reject(new Error("Retired read failure"));
        }
        await previous.promise.catch(() => undefined);
        flush();
        expect(element.textContent).toContain("Loading the full memory file");
        expect(element.textContent).not.toContain("Retired");

        current.resolve(memoryFileResponse("first\nFresh matched content\nthird"));
        await waitForSolid(() =>
          expect(element.querySelector('[data-memory-match="true"]')?.textContent).toBe(
            "Fresh matched content\nthird",
          ),
        );
      } finally {
        element.remove();
      }
    },
  );

  it.each([false])(
    "shows stale guidance alongside results and clears it after a fresh search (hits=%s)",
    async (hasHits) => {
      const warning =
        "Memory index is stale: index scope changed (owner: configuration, code: scope). Search results may be incomplete.";
      const action =
        "Run: openclaw memory status --index --agent main. Rebuilding uses keyword indexing only and does not call an embedding provider.";
      const fresh = { ...result, snippet: "Freshly indexed Ada prefers careful reviews." };
      const request = vi
        .fn<Request>()
        .mockResolvedValueOnce({
          agentId: "main",
          provider: "none",
          searchMode: "fts-only",
          results: hasHits ? [result] : [],
          stale: true,
          warning,
          action,
        })
        .mockResolvedValueOnce({
          agentId: "main",
          provider: "none",
          searchMode: "fts-only",
          results: [fresh],
        });
      const element = createElement(request);
      const readText = () => (element.textContent ?? "").replace(/\s+/gu, " ").trim();
      try {
        typeQuery(element, "Ada");
        submit(element);
        await waitForSolid(() =>
          expect(element.querySelector(".memory-memories__results-heading")).not.toBeNull(),
        );
        expect(element.querySelectorAll("article")).toHaveLength(hasHits ? 1 : 0);
        expect.soft(readText(), "stale result warning").toContain(warning);
        expect.soft(readText(), "agent-scoped recovery guidance").toContain(action);
        if (hasHits) {
          expect(readText()).toContain(result.snippet);
        }

        typeQuery(element, "Ada fresh");
        submit(element);
        await waitForSolid(() => expect(readText()).toContain(fresh.snippet));
        expect(readText()).not.toContain(warning);
        expect(readText()).not.toContain(action);
      } finally {
        element.remove();
      }
    },
  );
});
