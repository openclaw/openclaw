import { expect, it, vi } from "vitest";

it("boots the native onboarding fixture and retries setup through the production actions", async () => {
  const app = document.createElement("div");
  app.id = "app";
  document.body.append(app);
  const originalFetch = globalThis.fetch;
  let setupCalls = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/fixture/report") {
      return Promise.resolve(Response.json({}));
    }
    if (url.pathname !== "/fixture/setup") {
      return originalFetch(input, init);
    }
    setupCalls += 1;
    return Promise.resolve(
      setupCalls === 1
        ? new Response(null, { status: 503 })
        : Response.json({
            status: "configured",
            selected: {
              kind: "fixture",
              label: "Synthetic provider",
              detail: "Local fixture data",
              modelRef: "fixture/model",
            },
            alternatives: [],
            attempts: [],
            installedPlugins: [],
          }),
    );
  });
  try {
    // Import the actual native entrypoint, not another setup-card wrapper.
    await import("../../../../apps/linux/tests/fixtures/onboarding-card.tsx");
    await vi.waitFor(() => {
      expect(app.querySelector('[role="alert"]')?.textContent).toContain(
        "Fixture setup failed: 503",
      );
    });
    const retry = [...app.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();
    retry!.click();
    await vi.waitFor(() => {
      expect(app.querySelector("h2")?.textContent).toContain(
        "Using Synthetic provider (fixture/model)",
      );
    });
    expect(setupCalls).toBe(2);
    expect(app.querySelector(".custodian-setup__error")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
    app.remove();
  }
});
