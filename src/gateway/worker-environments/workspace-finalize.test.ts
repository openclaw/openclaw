import { describe, expect, it } from "vitest";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";

describe("final worker workspace fences", () => {
  it("rechecks local stability after the final quiescence renewal", async () => {
    const log: string[] = [];
    await verifyReconciledWorkspaceFinal(
      {
        manifestRef: "sha256:" + "a".repeat(64),
        changed: true,
        verifyStable: async () => {
          log.push("remote");
        },
        verifyLocalStable: async () => {
          log.push("local");
        },
      },
      {
        assertActive: async () => {
          log.push("quiescence");
        },
        resume: async () => {},
      },
    );

    expect(log).toEqual(["remote", "local", "quiescence", "local"]);
  });
});
