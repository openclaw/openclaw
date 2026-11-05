import "../test-utils/prepare-compiled-subprocesses.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("markdown-it", () => {
  throw new Error("Session route registration must not initialize public Markdown rendering");
});

describe("session route registration", () => {
  it("matches public routes without loading the document renderer", async () => {
    const { createControlUiSessionRoutes } = await import("./control-ui-session-routes.js");
    const routes = createControlUiSessionRoutes({ controlUiBasePath: "/control" });

    expect(routes.matches("/control/share/session")).toBe(true);
    expect(routes.matches("/control/share/session/card.png")).toBe(true);
    expect(routes.matches("/control/chat/main/example")).toBe(true);
    expect(routes.matches("/control/assets/app.js")).toBe(false);
    routes.dispose();
  });
});
