import { describe, expect, it } from "vitest";
import { GroupChatSchema } from "./zod-schema.core.js";

describe("GroupChatSchema historyLimit", () => {
  it("accepts zero to disable group history", () => {
    expect(() => GroupChatSchema.parse({ historyLimit: 0 })).not.toThrow();
  });

  it("rejects negative history limits", () => {
    expect(() => GroupChatSchema.parse({ historyLimit: -1 })).toThrow();
  });
});
