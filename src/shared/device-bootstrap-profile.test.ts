import { describe, expect, test } from "vitest";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  resolveBootstrapProfileScopesForRole,
} from "./device-bootstrap-profile.js";

describe("device bootstrap profile", () => {
  test("bounds bootstrap handoff scopes by role", () => {
    expect(
      resolveBootstrapProfileScopesForRole("operator", [
        "node.exec",
        "operator.admin",
        "operator.approvals",
        "operator.pairing",
        "operator.read",
        "operator.write",
      ]),
    ).toEqual(["operator.approvals", "operator.read", "operator.write"]);

    expect(
      resolveBootstrapProfileScopesForRole("node", ["node.exec", "operator.approvals"]),
    ).toEqual([]);
  });

  test("bootstrap handoff operator allowlist stays aligned with pairing setup profile", () => {
    expect([...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]).toEqual([
      "operator.approvals",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ]);
  });
});
