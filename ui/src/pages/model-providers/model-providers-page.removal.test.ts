/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import "../../lib/toast-host.tsx";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  expandProvider,
  requestCount,
  unmountPage,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function removalHarness(apiKey: unknown = "__OPENCLAW_REDACTED__", withAccount = true) {
  const harness = createHarness("writer");
  const original = harness.request.getMockImplementation()!;
  let removedAccount = false;
  let removedKey = false;
  const logout = vi.fn(async (params: { provider?: string; credentialType?: string }) => {
    if (params.credentialType === "api_key") {
      removedKey = true;
    } else {
      removedAccount = true;
    }
    return {
      provider: params.provider,
      removedProfiles: params.credentialType ? [] : ["openai:work"],
      abortedRunIds: [],
    };
  });
  harness.request.mockImplementation(
    async (method, params?: { provider?: string; credentialType?: string }) => {
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            provider: "openai",
            authProvider: "openai",
            apiKey: { source: "config" },
            profiles:
              withAccount && !removedAccount
                ? [
                    {
                      profileId: "openai:work",
                      type: "oauth",
                      status: "ok",
                      source: "inherited",
                      email: "work@example.invalid",
                      logoutSupported: true,
                    },
                  ]
                : [],
          },
        ]);
      }
      if (method === "config.get") {
        return {
          config: { models: { providers: { OpenAI: removedKey ? {} : { apiKey } } } },
          valid: true,
          hash: removedKey ? "removed" : "before",
        };
      }
      if (method === "models.authLogout") {
        return logout(params ?? {});
      }
      return original(method);
    },
  );
  const restoreDialogs = installDialogPolyfill();
  const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
  const page = appendPage(harness.context);
  await waitForSolid(() => expect(harness.runtimeConfig.state.configSnapshot?.hash).toBe("before"));
  const row = await expandProvider(page, "openai");
  async function confirm() {
    row.querySelector<HTMLButtonElement>(".provider-row__remove")!.click();
    await waitForSolid(() =>
      expect(document.body.querySelector(".exec-approval-actions button.danger")).not.toBeNull(),
    );
    const { modal } = await getRenderedModalDialog(document.body);
    const copy = modal.textContent ?? "";
    modal.querySelector<HTMLButtonElement>("button.danger")!.click();
    await waitForSolid(() =>
      expect(requestCount(harness.request, "models.authLogout")).toBeGreaterThan(0),
    );
    return copy;
  }
  return {
    ...harness,
    page,
    row,
    toast,
    logout,
    confirm,
    dispose() {
      unmountPage(page);
      restoreDialogs();
    },
  };
}

it.each(["agent", "reconnect", "access"] as const)(
  "does not send another removal after %s changes during the first command",
  async (change) => {
    const h = await removalHarness();
    const first = createDeferred<Awaited<ReturnType<typeof h.logout>>>();
    h.logout.mockImplementationOnce(() => first.promise);
    try {
      await h.confirm();
      const completion = h.runtimeConfig.runExternalMutation.mock.results.at(-1)!.value;
      if (change === "agent") {
        h.settingsAgentSelection.state.selectedId = "main";
        h.settingsAgentSelection.state.scopeId = "main";
        h.notifySelection();
      } else if (change === "reconnect") {
        h.publishPhase("connecting");
      } else {
        h.snapshot.hello = {
          ...h.snapshot.hello!,
          auth: { role: "operator", scopes: ["operator.read"] },
        };
        h.publishPhase("connected");
      }
      first.resolve({ provider: "openai", removedProfiles: ["openai:work"], abortedRunIds: [] });
      await completion;
      await h.page.updateComplete;
      expect(requestCount(h.request, "models.authLogout")).toBe(1);
      expect(h.toast.toast?.message ?? "").not.toContain("Logged out.");
    } finally {
      first.resolve({ provider: "openai", removedProfiles: [], abortedRunIds: [] });
      h.dispose();
    }
  },
);

it.each([true, false])(
  "explains the removal scope and completes every authorized step (saved account: %s)",
  async (withAccount) => {
    const h = await removalHarness(undefined, withAccount);
    try {
      const copy = await h.confirm();
      if (withAccount) {
        expect(copy).toContain("other agents");
      } else {
        expect(copy).not.toContain("Active runs");
      }
      expect(copy).toContain("OpenAI");
      expect(copy).toContain("configured aliases");
      expect(copy).not.toContain("Runs using it stop");
      await waitForSolid(() => expect(h.toast.toast?.message).toContain("Logged out."));
      expect(h.logout.mock.calls.map(([target]) => target)).toEqual([
        ...(withAccount ? [{ provider: "openai", agentId: "writer" }] : []),
        { provider: "OpenAI", credentialType: "api_key", agentId: "writer" },
      ]);
    } finally {
      h.dispose();
    }
  },
);

it.each([false, true])(
  "reports completed removals when a later key removal fails (refresh fails: %s)",
  async (failRefresh) => {
    const h = await removalHarness();
    h.logout.mockImplementationOnce(h.logout.getMockImplementation()!);
    h.logout.mockRejectedValueOnce(new Error("Synthetic key removal failure"));
    const original = h.request.getMockImplementation()!;
    if (failRefresh) {
      h.request.mockImplementation(async (method, ...args) => {
        if (method === "models.authStatus" && h.logout.mock.calls.length > 0) {
          throw new Error("Synthetic refresh failure");
        }
        return original(method, ...args);
      });
    }
    try {
      await h.confirm();
      await waitForSolid(() =>
        expect(h.toast.toast?.message).toContain("Synthetic key removal failure"),
      );
      expect(h.toast.toast?.message).toContain("removed so far: 1");
      if (failRefresh) {
        expect(h.toast.toast?.message).toContain("Synthetic refresh failure");
      } else {
        expect(h.page.querySelector('[data-profile-id="openai:work"]')).toBeNull();
      }
      expect(h.toast.toast?.message).not.toContain("Logged out.");
      expect(requestCount(h.request, "models.authLogout")).toBe(2);
    } finally {
      h.dispose();
    }
  },
);

it.each(["file", "exec"])(
  "does not offer a no-op removal for a %s secret reference alone",
  async (source) => {
    const h = await removalHarness(
      { source, provider: "vault", id: "__OPENCLAW_REDACTED__" },
      false,
    );
    try {
      expect(h.row.querySelector(".provider-row__remove")).toBeNull();
      expect(requestCount(h.request, "models.authLogout")).toBe(0);
    } finally {
      h.dispose();
    }
  },
);

it("names the retained secret reference when saved accounts can be removed", async () => {
  const h = await removalHarness({
    source: "file",
    provider: "vault",
    id: "__OPENCLAW_REDACTED__",
  });
  try {
    const copy = await h.confirm();
    expect(copy).toContain("Secret references in OpenAI");
    await waitForSolid(() => expect(h.toast.toast?.message).toContain("Logged out."));
    expect(h.logout.mock.calls.map(([target]) => target)).toEqual([
      { provider: "openai", agentId: "writer" },
    ]);
    expect(h.runtimeConfig.state.configSnapshot?.config).toMatchObject({
      models: { providers: { OpenAI: { apiKey: { source: "file", provider: "vault" } } } },
    });
  } finally {
    h.dispose();
  }
});
