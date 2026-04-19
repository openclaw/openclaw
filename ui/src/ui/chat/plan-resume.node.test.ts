import { describe, expect, it, vi } from "vitest";

vi.mock("../uuid.ts", () => ({
  generateUUID: () => "uuid-fixed",
}));

import { resumePendingPlanInteraction } from "./plan-resume.ts";

describe("resumePendingPlanInteraction", () => {
  it("sends a hidden continue message with a stable plan-resume idempotency prefix", async () => {
    const request = vi.fn(async () => undefined);
    await resumePendingPlanInteraction(
      {
        request,
      } as unknown as Parameters<typeof resumePendingPlanInteraction>[0],
      "agent:main:user:abc",
    );

    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main:user:abc",
      message: "continue",
      deliver: false,
      idempotencyKey: "plan-resume-uuid-fixed",
    });
  });
});
