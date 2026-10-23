/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { i18n, t } from "../i18n/index.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { AgentSelectOption } from "./agent-select-types.ts";
import type { AgentSelectElement } from "./agent-select.tsx";
import "./agent-select-registration.ts";

const AGENT_SELECT_TEST_TAG = "openclaw-agent-select";

beforeEach(() => {
  setAvatarGatewayOrigin(globalThis.location.origin);
});

afterEach(async () => {
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
});

const agents: GatewayAgentRow[] = [
  { id: "alpha", name: "Alpha agent" },
  { id: "beta", name: "Beta agent" },
];
const options: AgentSelectOption[] = agents.map((agent) => ({
  value: agent.id,
  label: agent.name ?? agent.id,
  agent,
}));

function createIdentity(
  agentId: string,
  overrides: Partial<AgentIdentityResult>,
): AgentIdentityResult {
  return {
    agentId,
    name: "",
    avatar: "",
    ...overrides,
  };
}

async function createAgentSelect(
  overrides: Partial<Omit<AgentSelectElement, keyof HTMLElement>> = {},
): Promise<AgentSelectElement> {
  const element = document.createElement(AGENT_SELECT_TEST_TAG);
  element.options = options;
  element.value = "alpha";
  Object.assign(element, overrides);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

it("preserves complete grapheme clusters in emoji avatar fallback", async () => {
  const agent = { id: "family", name: "Family", identity: { emoji: "👍🏻" } };
  const element = await createAgentSelect({
    options: [{ value: agent.id, label: agent.name, agent }],
    value: agent.id,
  });

  try {
    expect(element.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("👍🏻");
  } finally {
    element.remove();
  }
});

it("renders named scope icons and restores the selected agent avatar", async () => {
  const element = await createAgentSelect({
    options: [
      { value: "", label: "All agents", icon: "users" },
      { value: "alpha", label: "Alpha", agent: { id: "alpha", identity: { emoji: "🦞" } } },
    ],
    value: "",
  });

  const trigger = element.querySelector(".agent-select__trigger")!;
  const icon = trigger.querySelector(".agent-select__avatar--icon svg");
  expect(icon?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(icon?.childElementCount).toBeGreaterThan(0);
  expect(trigger.textContent).not.toContain("users");

  element.value = "alpha";
  await element.updateComplete;
  expect(trigger.querySelector(".agent-select__avatar--icon")).toBeNull();
  expect(trigger.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("🦞");
});

it("keeps a failed avatar on its fallback until the image changes", async () => {
  const invalidAvatar = "data:image/gif;base64,bm90LWFuLWltYWdl";
  const replacementAvatar = "data:image/png;base64,cmVwbGFjZW1lbnQ=";
  const element = await createAgentSelect({
    identityById: { alpha: createIdentity("alpha", { avatar: invalidAvatar }) },
  });
  const failedImage = element.querySelector<HTMLImageElement>(".agent-select__avatar img");
  expect(failedImage).not.toBeNull();
  failedImage?.dispatchEvent(new Event("error"));
  await element.updateComplete;
  await waitForSolid(() => expect(element.querySelector(".agent-select__avatar img")).toBeNull());
  await waitForFast(() =>
    expect(
      element.querySelector(".agent-select__avatar .identity-avatar__agent-face"),
    ).not.toBeNull(),
  );
  expect(element.querySelector(".agent-select__avatar")?.classList).toContain("is-fallback");

  element.accessibleLabel = "Choose another agent";
  await element.updateComplete;
  expect(element.querySelector(".agent-select__avatar img")).toBeNull();

  element.identityById = { alpha: createIdentity("alpha", { avatar: replacementAvatar }) };
  await element.updateComplete;
  expect(element.querySelector(".agent-select__avatar img")?.getAttribute("src")).toBe(
    replacementAvatar,
  );
  failedImage?.dispatchEvent(new Event("error"));
  await element.updateComplete;
  expect(element.querySelector(".agent-select__avatar img")?.getAttribute("src")).toBe(
    replacementAvatar,
  );
});

it("does not let a removed option's image error poison its replacement lease", async () => {
  const avatar = "data:image/png;base64,cmV0YWluZWQ=";
  const element = await createAgentSelect({
    identityById: { alpha: createIdentity("alpha", { avatar }) },
  });
  const retired = element.querySelector<HTMLImageElement>(".agent-select__trigger img")!;
  expect(retired.getAttribute("src")).toBe(avatar);
  element.options = options.filter((option) => option.value === "beta");
  element.value = "beta";
  await element.updateComplete;
  await waitForSolid(() => expect(element.querySelector(".agent-select__trigger img")).toBeNull());

  element.options = options;
  element.value = "alpha";
  await element.updateComplete;
  await waitForSolid(() =>
    expect(element.querySelector(".agent-select__trigger img")?.getAttribute("src")).toBe(avatar),
  );
  retired.dispatchEvent(new Event("error"));
  await element.updateComplete;
  await waitForSolid(() =>
    expect(element.querySelector(".agent-select__trigger img")?.getAttribute("src")).toBe(avatar),
  );
});

it("keeps both option routes and the selected avatar with token auth", async () => {
  const createObjectURL = vi
    .fn()
    .mockReturnValueOnce("blob:alpha")
    .mockReturnValueOnce("blob:beta");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const response = createDeferred<Response>();
  const fetchMock = vi.fn<typeof fetch>(async () => (await response.promise).clone());
  vi.stubGlobal("fetch", fetchMock);

  setAvatarGatewayOrigin(globalThis.location.origin, ["tok"]);
  const element = await createAgentSelect({
    identityById: {
      alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }),
      beta: createIdentity("beta", { avatar: "/avatar/beta" }),
    },
  });

  try {
    const avatar = element.querySelector(".agent-select__trigger .agent-select__avatar");
    expect(avatar?.classList).toContain("is-pending");
    expect(avatar?.classList).not.toContain("is-fallback");
    expect(fetchMock).toHaveBeenCalledWith(`${globalThis.location.origin}/avatar/alpha`, {
      credentials: "include",
      headers: { Authorization: "Bearer tok" },
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${globalThis.location.origin}/avatar/alpha`,
      `${globalThis.location.origin}/avatar/beta`,
    ]);

    response.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    await waitForFast(() => {
      expect(
        element.querySelector<HTMLImageElement>(".agent-select__avatar img")?.getAttribute("src"),
      ).toBe("blob:alpha");
      expect(element.querySelector('[value="beta"] img')?.getAttribute("src")).toBe("blob:beta");
    });
    expect(avatar?.classList).toContain("is-pending");
    avatar?.querySelector("img")?.dispatchEvent(new Event("load"));
    await waitForSolid(() => expect(avatar?.classList).not.toContain("is-pending"));
    element.accessibleLabel = "Choose an agent";
    await element.updateComplete;
    expect(avatar?.classList).not.toContain("is-pending");
    expect(avatar?.classList).not.toContain("is-fallback");
    expect(createObjectURL).toHaveBeenCalledTimes(2);

    element.remove();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    setAvatarGatewayOrigin(null);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:alpha");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:beta");
  } finally {
    response.resolve(new Response(null, { status: 404 }));
    element.remove();
    vi.unstubAllGlobals();
  }
});

it("refetches a failed local avatar after the auth credential rotates", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:rotated-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValue({ ok: true, blob: async () => new Blob(["avatar"], { type: "image/png" }) });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

  setAvatarGatewayOrigin(globalThis.location.origin, ["tok"]);
  const element = await createAgentSelect({
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitForFast(() => expect(element.querySelector(".agent-select__avatar img")).toBeNull());

    setAvatarGatewayOrigin(globalThis.location.origin, ["tok2"]);
    await element.updateComplete;

    await waitForFast(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(`${globalThis.location.origin}/avatar/alpha`, {
        credentials: "include",
        headers: { Authorization: "Bearer tok2" },
        signal: expect.any(AbortSignal),
      });
      expect(
        element.querySelector<HTMLImageElement>(".agent-select__avatar img")?.getAttribute("src"),
      ).toBe("blob:rotated-avatar");
    });
  } finally {
    element.remove();
    vi.unstubAllGlobals();
  }
});

it("aborts the stale request on auth rotation without duplicating the current fetch", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:rotated-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
  const pending: Array<{
    resolve: (response: Response) => void;
    signal: AbortSignal;
  }> = [];
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("missing agent avatar fetch signal");
    }
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, signal });
      signal.addEventListener("abort", () => reject(new Error("avatar fetch aborted")), {
        once: true,
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const avatarCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === `${globalThis.location.origin}/avatar/alpha`);

  setAvatarGatewayOrigin(globalThis.location.origin, ["tok"]);
  const element = await createAgentSelect({
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    expect(avatarCalls()).toHaveLength(1);
    setAvatarGatewayOrigin(globalThis.location.origin, ["tok2"]);
    await element.updateComplete;
    await waitForFast(() => expect(avatarCalls()).toHaveLength(2));

    await waitForFast(() => expect(pending[0]?.signal.aborted).toBe(true));
    expect(
      avatarCalls().map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer tok", "Bearer tok2"]);

    // Let the canceled request's rejection settle, then force another render while
    // the replacement is pending. It must not clear the replacement's route claim.
    await Promise.resolve();
    element.identityById = { ...element.identityById };
    await element.updateComplete;
    expect(avatarCalls()).toHaveLength(2);

    pending[1]?.resolve({
      ok: true,
      blob: async () => new Blob(["avatar"], { type: "image/png" }),
    } as Response);
    await waitForFast(() => {
      expect(
        element.querySelector<HTMLImageElement>(".agent-select__avatar img")?.getAttribute("src"),
      ).toBe("blob:rotated-avatar");
    });
  } finally {
    element.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["fetch", "body"] as const)(
  "aborts a stalled local avatar %s after the request deadline",
  async (stage) => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const blob = vi.fn<() => Promise<Blob>>();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("missing agent avatar fetch signal");
      }
      const waitForAbort = () =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("avatar request aborted")), {
            once: true,
          });
        });
      if (stage === "fetch") {
        return await waitForAbort();
      }
      blob.mockImplementation(waitForAbort);
      return { ok: true, blob } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    setAvatarGatewayOrigin(globalThis.location.origin, ["tok"]);
    const element = await createAgentSelect({
      identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
    });

    try {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (stage === "body") {
        await vi.advanceTimersByTimeAsync(0);
        expect(blob).toHaveBeenCalledTimes(1);
      }
      const [, fetchInit] = fetchMock.mock.calls[0] ?? [];
      expect(fetchInit?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetchInit?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchInit?.signal?.aborted).toBe(true);

      await waitForFast(() => {
        expect(element.querySelector(".agent-select__avatar img")).toBeNull();
        expect(element.querySelector(".identity-avatar__agent-face")).not.toBeNull();
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      element.remove();
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);

it("fetches a local avatar image without a header when token auth is not active", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:unauthenticated-avatar");
      static override revokeObjectURL = vi.fn();
    },
  );
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["avatar"], { type: "image/png" }),
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const element = await createAgentSelect({
    identityById: { alpha: createIdentity("alpha", { avatar: "/avatar/alpha" }) },
  });

  try {
    expect(fetchMock).toHaveBeenCalledWith(`${globalThis.location.origin}/avatar/alpha`, {
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
    await waitForFast(() => {
      expect(
        element.querySelector<HTMLImageElement>(".agent-select__avatar img")?.getAttribute("src"),
      ).toBe("blob:unauthenticated-avatar");
    });
  } finally {
    element.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps avatar text out of typeahead and announces option metadata", async () => {
  const element = await createAgentSelect({
    accessibleLabel: "Agent",
    options: options.map((option) =>
      option.value === "beta"
        ? Object.assign({}, option, { description: "Handles research", badge: "Default" })
        : option,
    ),
    value: "beta",
  });

  try {
    const items = Array.from(
      element.querySelectorAll<HTMLElement & { value: string }>("[data-agent-option]"),
    );
    expect(items.find((item) => item.getAttribute("value") === "alpha")?.textContent?.trim()).toBe(
      "Alpha agent",
    );
    expect(
      items.find((item) => item.getAttribute("value") === "beta")?.getAttribute("aria-label"),
    ).toBe("Beta agent, Handles research, Default");
    expect(element.querySelector(".agent-select__trigger")?.getAttribute("aria-label")).toBe(
      "Agent: Beta agent, Default",
    );
  } finally {
    element.remove();
  }
});

it("refreshes translated labels when the locale changes while mounted", async () => {
  await i18n.setLocale("en");
  const element = await createAgentSelect({ options: [], value: "" });

  try {
    const label = element.querySelector(".agent-select__label");
    const englishLabel = label?.textContent?.trim();

    await i18n.setLocale("zh-CN");
    await element.updateComplete;

    const translatedLabel = element.querySelector(".agent-select__label");
    expect(translatedLabel?.textContent?.trim()).toBe(t("agents.noAgents"));
    expect(translatedLabel?.textContent?.trim()).not.toBe(englishLabel);
  } finally {
    element.remove();
    await i18n.setLocale("en");
  }
});
