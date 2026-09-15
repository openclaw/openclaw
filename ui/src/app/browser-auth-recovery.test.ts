/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { startBrowserAuthRecovery } from "./browser-auth-recovery.ts";
import { fetchControlUiResource, subscribeBrowserAuthRestored } from "./browser-http.ts";

function redirectResponse() {
  return Object.defineProperty(new Response(null, { status: 302 }), "type", {
    value: "opaqueredirect",
  });
}

function button(label: string) {
  const result = [...document.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!result) {
    throw new Error(`Missing button: ${label}`);
  }
  return result;
}

describe("browser sign-in recovery", () => {
  let stop: () => void;
  let restoreDialog: () => void;
  let now: number;

  beforeEach(() => {
    now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    restoreDialog = installDialogPolyfill();
    stop = startBrowserAuthRecovery("/nested");
  });

  afterEach(() => {
    stop();
    document.body.replaceChildren();
    restoreDialog();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deduplicates failed reads and retries their owners after sign-in without navigating the chat", async () => {
    let authenticated = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return authenticated
          ? new Response(null, { headers: { "content-type": "application/json" } })
          : redirectResponse();
      }
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const restored = vi.fn();
    onTestFinished(subscribeBrowserAuthRestored(restored));
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const initialLocation = window.location.href;
    const requests = ["image-a", "image-b"].map((name) =>
      fetchControlUiResource(`/nested/__openclaw__/assistant-media?source=${name}`),
    );
    const results = await Promise.allSettled(requests);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    await expect.poll(() => document.querySelector("openclaw-modal-dialog")).not.toBeNull();
    const { dialog } = await getRenderedModalDialog(document.body);
    expect(dialog.getAttribute("aria-label")).toBe("Sign in to continue loading content");
    expect(document.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "HEAD")).toEqual([
      [
        `${window.location.origin}/nested/control-ui-config.json`,
        expect.objectContaining({
          redirect: "manual",
          cache: "no-store",
          credentials: "same-origin",
        }),
      ],
    ]);

    button("Sign in").click();
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      `${window.location.origin}/nested/`,
      "_blank",
      "noopener,noreferrer",
    );
    button("Check again").click();
    await expect.poll(() => document.body.textContent).toContain("Sign-in is still required");
    expect(restored).not.toHaveBeenCalled();

    authenticated = true;
    window.dispatchEvent(new Event("focus"));
    await expect.poll(() => restored.mock.calls.length).toBe(1);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(window.location.href).toBe(initialLocation);
  });

  it.each(["offline", "missing", "server-error", "gateway-auth", "html"])(
    "does not turn %s into a sign-in dialog",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method !== "HEAD" || failure === "offline") {
            throw new TypeError("Failed to fetch");
          }
          return new Response(null, {
            status:
              failure === "missing"
                ? 404
                : failure === "server-error"
                  ? 503
                  : failure === "gateway-auth"
                    ? 401
                    : 200,
            headers: { "content-type": "text/html" },
          });
        }),
      );
      await expect(fetchControlUiResource("/nested/__openclaw__/assistant-media")).rejects.toThrow(
        "Failed to fetch",
      );
      await Promise.resolve();
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it.each(["stored-token", "stored-password"])(
    "verifies renewed website access using the current %s credential",
    async (acceptedCredential) => {
      stop();
      stop = startBrowserAuthRecovery("/nested", () => ({
        hello: { auth: { deviceToken: "expired-device-token" } },
        settings: { token: "stored-token" },
        password: "stored-password",
      }));
      let signedIn = false;
      const credentials: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method !== "HEAD") {
            throw new TypeError("Failed to fetch");
          }
          expect(init.redirect).toBe("manual");
          if (!signedIn) {
            return redirectResponse();
          }
          const authorization = new Headers(init.headers).get("Authorization") ?? "";
          credentials.push(authorization);
          return authorization === `Bearer ${acceptedCredential}`
            ? new Response(null, { headers: { "content-type": "application/json" } })
            : new Response(null, { status: 401 });
        }),
      );
      const restored = vi.fn();
      onTestFinished(subscribeBrowserAuthRestored(restored));
      await expect(
        fetchControlUiResource("/nested/__openclaw__/assistant-media"),
      ).rejects.toThrow();
      await getRenderedModalDialog(document.body);
      signedIn = true;
      window.dispatchEvent(new Event("focus"));
      await expect.poll(() => restored.mock.calls.length).toBe(1);
      expect(credentials).toEqual([
        "Bearer expired-device-token",
        "Bearer stored-token",
        ...(acceptedCredential === "stored-password" ? ["Bearer stored-password"] : []),
      ]);
      expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
    },
  );

  it("discards recovery from a credential replaced while the probe was pending", async () => {
    stop();
    let token = "original-token";
    vi.spyOn(window, "open").mockReturnValue(null);
    stop = startBrowserAuthRecovery("/nested", () => ({ settings: { token } }));
    const probe = createDeferred<Response>();
    const success = () => new Response(null, { headers: { "content-type": "application/json" } });
    let probes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== "HEAD") {
          throw new TypeError("Failed to fetch");
        }
        probes += 1;
        if (probes === 1) {
          return redirectResponse();
        }
        if (probes === 2) {
          return probe.promise;
        }
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer replacement-token");
        return success();
      }),
    );
    const restored = vi.fn();
    onTestFinished(subscribeBrowserAuthRestored(restored));
    await expect(fetchControlUiResource("/nested/__openclaw__/assistant-media")).rejects.toThrow();
    await getRenderedModalDialog(document.body);
    button("Sign in").click();
    window.dispatchEvent(new Event("focus"));
    token = "replacement-token";
    probe.resolve(success());
    await expect.poll(() => button("Check again").disabled).toBe(false);
    expect(restored).not.toHaveBeenCalled();
    expect(document.querySelector("openclaw-modal-dialog")).not.toBeNull();
    button("Check again").click();
    await expect.poll(() => restored.mock.calls.length).toBe(1);
  });

  it("keeps dismissal quiet across later automatic attachment retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return redirectResponse();
        }
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchControlUiResource("/nested/__openclaw__/assistant-media")).rejects.toThrow();
    await getRenderedModalDialog(document.body);
    button("Not now").click();
    now += 30_001;
    await expect(fetchControlUiResource("/nested/__openclaw__/assistant-media")).rejects.toThrow();
    await Promise.resolve();
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("ignores external requests, sibling roots, and aborted callers", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.allSettled([
      fetchControlUiResource("https://external.example/file"),
      fetchControlUiResource("/nested-other/file"),
      fetchControlUiResource("/nested/file", { signal: AbortSignal.abort() }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("discards an in-flight probe when its document owner stops", async () => {
    const probe = createDeferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          return probe.promise;
        }
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchControlUiResource("/nested/__openclaw__/assistant-media")).rejects.toThrow();
    stop();
    probe.resolve(redirectResponse());
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});
