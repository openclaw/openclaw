import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("telegram actions schema", () => {
  it("accepts editMessage and createForumTopic action toggles", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          actions: {
            editMessage: true,
            createForumTopic: true,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
