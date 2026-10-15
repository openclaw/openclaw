/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import * as diffSyntax from "./chat-diff-highlight.runtime.ts";
import { SessionDiffPanel } from "./session-diff-panel.ts";
import type {
  SessionDiffFileTextLoader,
  SessionDiffLoader,
  SessionDiffOwner,
} from "./session-diff-panel.ts";

type SessionDiffElement = HTMLElement & {
  owner: SessionDiffOwner | null;
  openFile: ((path: string) => void) | null;
  revealFile: ((path: string) => void) | null;
  execNode: string | null;
  loadFileText: SessionDiffFileTextLoader | null;
  loader: SessionDiffLoader | null;
  readonly updateComplete: Promise<boolean>;
};

function mountPanel() {
  let panel!: SessionDiffElement;
  mountSolid(() =>
    createComponent(SessionDiffPanel, {
      ref: (element) => {
        panel = element;
      },
    }),
  );
  return panel;
}

function settlePanel(panel: SessionDiffElement) {
  return waitForSolid(() =>
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false"),
  );
}

function result(branch: string): SessionsDiffResult {
  return {
    sessionKey: "agent:main:test",
    branch,
    baseRef: "main",
    files: [],
    additions: 0,
    deletions: 0,
  };
}

const SNAPSHOT_PATCH = [
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -3 +3 @@",
  "-before",
  "+snapshot line",
].join("\n");

const FRESH_PATCH = [
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -1,3 +1,3 @@",
  " fresh gap edit",
  " context",
  "-before",
  "+fresh snapshot line",
].join("\n");

function fileResult(patch: string): SessionsDiffResult {
  return {
    sessionKey: "agent:main:test",
    branch: "feature/test",
    baseRef: "main",
    files: [
      {
        path: "example.txt",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch,
      },
    ],
    additions: 1,
    deletions: 1,
  };
}

afterEach(async () => {
  await vi.dynamicImportSettled();
  document.body.replaceChildren();
  clearNativeGatewayTestState();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("SessionDiffPanel", () => {
  it("distinguishes incomplete diff results from a clean checkout", async () => {
    setNativeGatewayTestState(null);
    const panel = mountPanel();
    panel.loader = async () => ({ ...result("feature/test"), truncated: true });
    await settlePanel(panel);

    expect(panel.textContent).not.toContain("No changes in this session's checkout.");
    expect(panel.textContent).toContain("Some changes could not be displayed.");
    expect(panel.querySelector(".session-diff__file")).toBeNull();

    panel.loader = async () => ({
      ...result("feature/test"),
      truncated: true,
      files: [
        { path: "example.txt", status: "added", additions: 0, deletions: 0, truncated: true },
      ],
    });
    await settlePanel(panel);

    expect(panel.querySelector(".session-diff__filename")?.textContent).toBe("example.txt");
    expect(panel.textContent).toContain("Diff preview is unavailable.");
    expect(panel.textContent).toContain("Some changes could not be displayed.");
    expect(panel.textContent).not.toContain("No changes in this session's checkout.");

    panel.loader = async () => ({ ...fileResult(SNAPSHOT_PATCH), truncated: true });
    await settlePanel(panel);

    expect(panel.querySelector(".session-diff__filename")?.textContent).toBe("example.txt");
    expect(panel.textContent).toContain("snapshot line");
    expect(panel.textContent).not.toContain("Diff preview is unavailable.");
    expect(panel.textContent).toContain("Some changes could not be displayed.");
    expect(panel.textContent).not.toContain("No changes in this session's checkout.");

    panel.loader = async () => result("feature/test");
    await settlePanel(panel);

    expect(panel.textContent).toContain("No changes in this session's checkout.");
    expect(panel.textContent).not.toContain("Some changes could not be displayed.");
    expect(panel.querySelector(".session-diff__file")).toBeNull();
  });

  it("keeps stopped cloud changes visible with restart guidance and no local checkout action", async () => {
    setNativeGatewayTestState("local");
    const panel = mountPanel();
    panel.loader = async () => ({
      ...result("cloud/session"),
      unavailableReason: "workspace_stopped",
      files: [{ path: "saved.txt", status: "modified", additions: 0, deletions: 0 }],
    });
    await waitForSolid(() => expect(panel.textContent).toContain("Saved changed files are shown."));
    expect(panel.textContent).toContain("saved.txt");
    expect(panel.textContent).toContain("Start the cloud session to load this diff.");
    expect(panel.textContent).not.toContain("Diff preview is unavailable.");
    expect(panel.textContent).not.toContain("No changes in this session");
    expect(panel.querySelector(".session-diff__toolbar-button")).toBeNull();
    panel.querySelector<HTMLButtonElement>(".session-diff__file-menu")?.click();
    await panel.updateComplete;
    flush();
    expect(panel.querySelector("openclaw-session-diff-menu")?.textContent).not.toContain(
      "Open in Editor",
    );
  });

  it("renders a skeleton only while a real diff request is pending", async () => {
    setNativeGatewayTestState(null);
    const pending = deferred<SessionsDiffResult>();
    const panel = mountPanel();

    await panel.updateComplete;
    flush();
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");

    panel.loader = vi.fn(() => pending.promise);
    await waitForSolid(() => {
      expect(panel.querySelector("openclaw-panel-loading-skeleton")?.variant).toBe("review");
      expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("true");
    });

    pending.resolve(result("feature/pending"));
    await waitForSolid(() => expect(panel.textContent).toContain("feature/pending"));
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");

    const replacement = deferred<SessionsDiffResult>();
    panel.owner = { agentId: "main", sessionKey: "another-session" };
    panel.loader = () => replacement.promise;
    await panel.updateComplete;
    flush();
    expect(panel.querySelector("openclaw-panel-loading-skeleton")?.variant).toBe("review");
    expect(panel.textContent).not.toContain("feature/pending");
    replacement.resolve(result("feature/replacement"));
    await waitForSolid(() => expect(panel.textContent).toContain("feature/replacement"));

    panel.loader = async () => {
      throw new Error("Diff unavailable");
    };
    await waitForSolid(() =>
      expect(panel.querySelector(".callout.danger")?.textContent).toContain("Diff unavailable"),
    );
    expect(panel.textContent).not.toContain("feature/replacement");
  });

  it.each([true])("highlights source in split=%s without changing its text", async (split) => {
    setNativeGatewayTestState(null);
    localStorage.setItem("openclaw.control.sessionDiff.v1", JSON.stringify({ split }));
    const panel = mountPanel();
    localStorage.removeItem("openclaw.control.sessionDiff.v1");
    const patch = [
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,5 +1,5 @@",
      " /* comment",
      "-old comment",
      "+new comment",
      " */",
      " ",
      '-const value = "before";',
      '+const value = "<img src=x onerror=alert(1)>";',
    ].join("\n");
    const data = fileResult(patch);
    data.files[0]!.path = "example.ts";
    panel.loader = async () => data;
    await panel.updateComplete;
    flush();
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(
        [...panel.querySelectorAll(".tok-string")].map((node) => node.textContent).join(""),
      ).toContain("before"),
    );
    expect(
      [...panel.querySelectorAll(".tok-comment")].map((node) => node.textContent).join(""),
    ).toContain("new comment");
    expect(panel.querySelector(".tok-keyword")?.textContent).toBe("const");
    expect(panel.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(panel.querySelector("img")).toBeNull();
    const textSelector = split ? ".session-diff-split__text" : ".chat-diff__text";
    expect([...panel.querySelectorAll(textSelector)].map((line) => line.textContent)).toContain("");

    // Reusing the panel for an unknown file type must discard the prior language.
    panel.loader = async () => ({ ...data, files: [{ ...data.files[0]!, path: "example.txt" }] });
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__filename")?.textContent).toBe("example.txt"),
    );
    expect(panel.querySelector(".tok-keyword")).toBeNull();
    expect([...panel.querySelectorAll(textSelector)].map((line) => line.textContent)).toContain("");
  });

  it.each([true])("highlights both languages of a rename in split=%s", async (split) => {
    setNativeGatewayTestState(null);
    localStorage.setItem("openclaw.control.sessionDiff.v1", JSON.stringify({ split }));
    const panel = mountPanel();
    localStorage.removeItem("openclaw.control.sessionDiff.v1");
    const before = '<section data-mode="before">Hello</section>';
    const after = 'const value = "after";';
    const data = fileResult(
      ["--- a/example.html", "+++ b/example.ts", "@@ -1 +1 @@", `-${before}`, `+${after}`].join(
        "\n",
      ),
    );
    data.files[0] = {
      ...data.files[0]!,
      path: "example.ts",
      oldPath: "example.html",
      status: "renamed",
    };
    panel.loader = async () => data;
    await panel.updateComplete;
    flush();
    await vi.dynamicImportSettled();

    const oldSide = split
      ? ".session-diff-split__side--left.session-diff-split__side--filled"
      : ".chat-diff__row--del";
    const newSide = split
      ? ".session-diff-split__side--right.session-diff-split__side--filled"
      : ".chat-diff__row--add";
    const text = split ? ".session-diff-split__text" : ".chat-diff__text";
    await waitForSolid(() => {
      expect(panel.querySelector(`${oldSide} .tok-propertyName`)?.textContent).toBe("data-mode");
      expect(panel.querySelector(`${newSide} .tok-keyword`)?.textContent).toBe("const");
    });
    expect(panel.querySelector(`${oldSide} ${text}`)?.textContent).toBe(before);
    expect(panel.querySelector(`${newSide} ${text}`)?.textContent).toBe(after);
  });

  it.each([
    { surface: "file", failed: true, feedback: "Copy failed" },
    { surface: "sync", failed: false, feedback: "Copied!" },
  ])(
    "keeps $surface path copy feedback visible: $feedback",
    async ({ surface, failed, feedback }) => {
      const writeText = failed
        ? vi.fn().mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"))
        : vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      setNativeGatewayTestState(null);
      const panel = mountPanel();
      panel.loader = vi.fn(async () => ({ ...fileResult(SNAPSHOT_PATCH), root: "/workspace" }));

      const triggerSelector =
        surface === "file" ? ".session-diff__file-menu" : ".session-diff__toolbar-button";
      await waitForSolid(() => expect(panel.querySelector(triggerSelector)).not.toBeNull());
      panel.querySelector<HTMLButtonElement>(triggerSelector)?.click();
      await panel.updateComplete;
      flush();

      const menu = panel.querySelector("openclaw-session-diff-menu");
      expect(menu).not.toBeNull();
      const label = surface === "file" ? "Copy Path" : "Checkout path";
      const button = menu?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).toBeInstanceOf(HTMLButtonElement);

      button?.click();
      await waitForSolid(() => expect(button?.getAttribute("aria-label")).toBe(feedback));

      expect(writeText).toHaveBeenCalledWith(surface === "file" ? "example.txt" : "/workspace");
      const status = button?.parentElement?.querySelector<HTMLElement>('[role="status"]');
      expect(status?.textContent).toBe(feedback);
      expect(status?.hidden).toBe(false);
      expect(panel.querySelector("openclaw-session-diff-menu")).toBe(menu);
    },
  );

  it.each([
    { name: "plain browser", nativeGateway: null, offered: false },
    { name: "native remote gateway", nativeGateway: "remote", offered: false },
    {
      name: "remote execution node",
      nativeGateway: "local",
      execNode: "build-mac",
      offered: false,
    },
  ] as const)("offers file editors only for native-local checkouts: $name", async (testCase) => {
    setNativeGatewayTestState(testCase.nativeGateway);
    const panel = mountPanel();
    panel.execNode = "execNode" in testCase ? (testCase.execNode ?? null) : null;
    panel.loader = vi.fn(async () => ({ ...fileResult(SNAPSHOT_PATCH), root: "/workspace" }));

    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__file-menu")).not.toBeNull(),
    );
    panel.querySelector<HTMLButtonElement>(".session-diff__file-menu")?.click();
    await panel.updateComplete;
    flush();

    const menu = panel.querySelector("openclaw-session-diff-menu");
    expect(menu?.textContent?.includes("Open in Editor")).toBe(testCase.offered);
    expect(menu?.textContent?.includes("Cursor")).toBe(testCase.offered);
  });

  it("closes an open editor menu when the native gateway switches to remote", async () => {
    setNativeGatewayTestState("local");
    const panel = mountPanel();
    panel.loader = vi.fn(async () => ({ ...fileResult(SNAPSHOT_PATCH), root: "/workspace" }));

    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__file-menu")).not.toBeNull(),
    );
    panel.querySelector<HTMLButtonElement>(".session-diff__file-menu")?.click();
    await panel.updateComplete;
    flush();
    expect(panel.querySelector("openclaw-session-diff-menu")?.textContent).toContain(
      "Open in Editor",
    );

    setNativeGatewayTestState("remote");
    await panel.updateComplete;
    flush();

    expect(panel.querySelector("openclaw-session-diff-menu")).toBeNull();
  });

  it("commits only the latest loader result after a rapid loader change", async () => {
    const first = deferred<SessionsDiffResult>();
    const second = deferred<SessionsDiffResult>();
    const firstLoader = vi.fn(() => first.promise);
    const secondLoader = vi.fn(() => second.promise);
    const panel = mountPanel();
    panel.loader = firstLoader;

    await waitForSolid(() => expect(firstLoader).toHaveBeenCalledOnce());
    expect(firstLoader).toHaveBeenCalledWith({ scope: "all" });
    panel.loader = secondLoader;
    await waitForSolid(() => expect(secondLoader).toHaveBeenCalledOnce());

    second.resolve(result("feature/latest"));
    await waitForSolid(() => expect(panel.textContent).toContain("feature/latest"));
    first.resolve(result("feature/stale"));
    await panel.updateComplete;
    flush();

    expect(panel.textContent).toContain("feature/latest");
    expect(panel.textContent).not.toContain("feature/stale");
  });

  it("keeps collapsed file bodies unmounted through a refresh", async () => {
    const panel = mountPanel();
    panel.loader = async () => fileResult(SNAPSHOT_PATCH);
    await waitForSolid(() => expect(panel.textContent).toContain("snapshot line"));
    panel.querySelector<HTMLButtonElement>(".session-diff__file-toggle")!.click();
    flush();
    expect(panel.querySelector(".session-diff__file-body")).toBeNull();

    const refreshed = vi.fn(async () => fileResult(FRESH_PATCH));
    panel.loader = refreshed;
    await waitForSolid(() => {
      expect(refreshed).toHaveBeenCalledOnce();
      expect(panel.querySelector(".session-diff")?.getAttribute("aria-busy")).toBe("false");
    });
    expect(panel.querySelector(".session-diff__file-body")).toBeNull();
    panel.querySelector<HTMLButtonElement>(".session-diff__file-toggle")!.click();
    await waitForSolid(() => expect(panel.textContent).toContain("fresh snapshot line"));
  });

  it("refreshes the diff instead of expanding file text from a stale gap snapshot", async () => {
    const loader = vi
      .fn<SessionDiffLoader>()
      .mockResolvedValueOnce(fileResult(SNAPSHOT_PATCH))
      .mockResolvedValueOnce(fileResult(FRESH_PATCH));
    const loadFileText = vi
      .fn<SessionDiffFileTextLoader>()
      .mockResolvedValue(["expanded current file line", "context", "snapshot line"].join("\n"));
    const panel = mountPanel();
    panel.loader = loader;
    panel.loadFileText = loadFileText;

    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__gap-count")).not.toBeNull(),
    );
    (panel.querySelector(".session-diff__gap-count") as HTMLButtonElement).click();

    await waitForSolid(() => expect(panel.textContent).toContain("fresh snapshot line"));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader).toHaveBeenNthCalledWith(2, { scope: "all" });
    expect(loadFileText).not.toHaveBeenCalled();
    expect(panel.textContent).not.toContain("expanded current file line");
    expect(panel.querySelector(".session-diff__gap-controls")).toBeNull();
  });
});

describe("manual code folding", () => {
  it("defers changed-source analysis while a file is collapsed and reuses prepared syntax", async () => {
    const analyze = vi.spyOn(diffSyntax, "analyzeDiffSyntax");
    const patch = "@@ -1,3 +1,3 @@\n function greet() {\n-  return 1;\n+  return 2;\n }";
    let current = {
      ...fileResult(patch),
      files: [{ ...fileResult(patch).files[0]!, path: "example.ts" }],
    };
    const panel = mountPanel();
    panel.loader = async () => current;
    const click = (selector: string) => panel.querySelector<HTMLButtonElement>(selector)!.click();
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__code-toggle")).not.toBeNull(),
    );
    expect(analyze).toHaveBeenCalledTimes(1);
    click(".session-diff__file-toggle");
    flush();
    current = {
      ...current,
      files: [{ ...current.files[0]!, patch: patch.replace("return 2", "return 3") }],
    };
    click(".session-diff__refresh");
    await settlePanel(panel);
    await vi.dynamicImportSettled();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(panel.querySelector(".session-diff__file-body")).toBeNull();
    click(".session-diff__file-toggle");
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__code-toggle")).not.toBeNull(),
    );
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(panel.textContent).toContain("return 3;");
    click(".session-diff__code-toggle");
    flush();
    click(".session-diff__file-toggle");
    flush();
    click(".session-diff__refresh");
    await settlePanel(panel);
    await vi.dynamicImportSettled();
    click(".session-diff__file-toggle");
    await waitForSolid(() =>
      expect(panel.querySelector(".session-diff__code-placeholder")).not.toBeNull(),
    );
    await vi.dynamicImportSettled();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(panel.textContent).not.toContain("return 3;");
  });

  it("refreshes metadata when a truncated file still has no patch", async () => {
    let current: SessionsDiffResult = {
      ...result("feature/test"),
      additions: 100001,
      files: [
        {
          path: "large.ts",
          status: "added",
          additions: 100001,
          deletions: 0,
          untracked: true,
          truncated: true,
        },
      ],
    };
    const panel = mountPanel();
    panel.loader = async () => current;
    await settlePanel(panel);
    expect(panel.querySelector(".session-diff__file .chat-diffstat__add")?.textContent).toBe(
      "+100001",
    );
    expect(panel.querySelector(".session-diff__badge")).not.toBeNull();
    const originalToggle = panel.querySelector(".session-diff__file-toggle");
    current = {
      ...current,
      additions: 100010,
      deletions: 2,
      files: [
        { path: "large.ts", status: "modified", additions: 100010, deletions: 2, truncated: true },
      ],
    };
    panel.querySelector<HTMLButtonElement>(".session-diff__refresh")!.click();
    await settlePanel(panel);
    expect(panel.querySelector(".session-diff__file .chat-diffstat__add")?.textContent).toBe(
      "+100008",
    );
    expect(panel.querySelector(".session-diff__file .chat-diffstat__mod")?.textContent).toBe("~2");
    expect(panel.querySelector(".session-diff__file")?.getAttribute("data-status")).toBe(
      "modified",
    );
    expect(panel.querySelector(".session-diff__badge")).toBeNull();
    expect(panel.querySelector(".session-diff__file-toggle")).toBe(originalToggle);
  });

  it("removes folded rows, retains layout state, and resets only when source changes", async () => {
    localStorage.setItem(
      "openclaw.control.sessionDiff.v1",
      JSON.stringify({ split: true, wrap: false }),
    );
    const patch = `@@ -1,5 +1,5 @@
 function greet() {
   if (true) {
-    return 2;
+    return 3;
   }
 }`;
    const response = () => ({
      ...fileResult(patch),
      files: [{ ...fileResult(patch).files[0]!, path: "example.ts" }],
    });
    let current = response();
    const panel = mountPanel();
    panel.loader = async () => current;
    const click = (selector: string) => panel.querySelector<HTMLButtonElement>(selector)!.click();
    async function menu(trigger: string, action: string) {
      click(trigger);
      await waitForSolid(() => expect(panel.querySelector("wa-dropdown")).not.toBeNull());
      panel
        .querySelector("wa-dropdown")!
        .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: action } } }));
      flush();
    }
    await waitForSolid(() =>
      expect(panel.querySelectorAll(".session-diff__code-toggle")).toHaveLength(2),
    );
    expect(panel.textContent).toContain("return 3;");
    expect(panel.querySelector(".chat-diff__change--add")?.textContent).toBe("3");
    click('.session-diff__code-toggle[aria-label="Collapse code at line 2"]');
    await waitForSolid(() => expect(panel.textContent).not.toContain("return 3;"));
    expect(panel.querySelector(".session-diff__code-placeholder")?.textContent).toContain("+1");
    await menu(".session-diff__toolbar-icon", "toggle-split");
    await waitForSolid(() => expect(panel.querySelector(".chat-diff")).not.toBeNull());
    expect(panel.textContent).not.toContain("return 2;");
    click(".session-diff__refresh");
    await settlePanel(panel);
    expect(panel.textContent).not.toContain("return 3;");
    await menu(".session-diff__file-menu", "expand-code");
    await waitForSolid(() => expect(panel.textContent).toContain("return 3;"));
    await menu(".session-diff__file-menu", "collapse-functions");
    await waitForSolid(() => expect(panel.textContent).not.toContain("if (true)"));
    click(".session-diff__code-placeholder");
    await waitForSolid(() => expect(panel.textContent).toContain("return 3;"));
    await menu(".session-diff__file-menu", "collapse-code");
    current = {
      ...response(),
      files: [{ ...response().files[0]!, patch: patch.replace("return 3", "return 4") }],
    };
    click(".session-diff__refresh");
    await waitForSolid(() => expect(panel.textContent).toContain("return 4;"));
    expect(panel.querySelector(".session-diff__code-placeholder")).toBeNull();
    await waitForSolid(() =>
      expect(panel.querySelectorAll(".session-diff__code-toggle")).toHaveLength(2),
    );
    await menu(".session-diff__file-menu", "collapse-functions");
    await waitForSolid(() => expect(panel.textContent).not.toContain("return 4;"));
    await menu(".session-diff__file-menu", "expand-code");
    await waitForSolid(() => expect(panel.textContent).toContain("return 4;"));
  });
});
