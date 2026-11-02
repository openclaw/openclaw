import { expect, it } from "vitest";
import { controlUiSessionPath, controlUiSessionUrl } from "./control-ui-e2e-session-urls.ts";

it("binds ownerless global links to the configured fixture agent", () => {
  expect(controlUiSessionPath("global", "/ui", "chat", "ops")).toBe("/ui/chat/ops");
  expect(controlUiSessionUrl("http://fixture.invalid/ui/", "global", "chat", "ops")).toBe(
    "http://fixture.invalid/ui/chat/ops",
  );
  expect(
    controlUiSessionUrl("http://fixture.invalid/", "agent:research:review", "chat", "ops"),
  ).toBe("http://fixture.invalid/chat/research/review");
});
