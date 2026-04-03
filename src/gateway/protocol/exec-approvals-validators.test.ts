import { describe, expect, it } from "vitest";
import {
  validateExecApprovalsNodeSetParams,
  validateExecApprovalsSetParams,
} from "./index.js";

describe("exec approvals protocol validators", () => {
  it("accepts allowlist entries with allow-always source metadata", () => {
    const file = {
      version: 1 as const,
      agents: {
        main: {
          allowlist: [
            {
              id: "entry-1",
              pattern: "/usr/bin/python3",
              source: "allow-always" as const,
            },
          ],
        },
      },
    };

    expect(
      validateExecApprovalsSetParams({
        file,
        baseHash: "abc123",
      }),
    ).toBe(true);

    expect(
      validateExecApprovalsNodeSetParams({
        nodeId: "node-1",
        file,
        baseHash: "abc123",
      }),
    ).toBe(true);
  });
});
