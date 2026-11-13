import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { authorizeSessionSourceCreation } from "./session-create-source-access.js";

const cfg: OpenClawConfig = {
  session: {
    sharing: {
      accessPolicy: {
        default: "creator",
        groups: [
          { agentId: "main", channel: "telegram", peerId: "-100123", profileIds: ["selected"] },
        ],
      },
    },
  },
};
const operator = {
  cfg,
  operatorRoleActor: { kind: "operator" as const, profileId: "selected" },
  requestingOperatorScopes: ["operator.read", "operator.write"],
};

it.each([
  "agent:main:telegram:group:-100123",
  "agent:main:telegram:group:-100123:topic:7",
  "agent:main:telegram:group:-100999:thread:7",
  "agent:main:telegram:bot:group:-100123:topic:7",
  "agent:main:telegram:direct:123:thread:123:7",
  "agent:main:telegram:bot:direct:123:thread:123:7",
  "agent:main:other-channel:channel:opaque:peer",
])("refuses operator preclaim of %s, even for a selected audience member", (key) => {
  expect(authorizeSessionSourceCreation(operator, key)).toMatchObject({ code: "FORBIDDEN" });
  expect(authorizeSessionSourceCreation({ cfg, requestingOperatorScopes: [] }, key)).toMatchObject({
    code: "FORBIDDEN",
  });
});

it.each(["agent:main:dashboard:private", "agent:main:subagent:child", "agent:main:own-chat"])(
  "preserves ordinary creation of %s",
  (key) => expect(authorizeSessionSourceCreation(operator, key)).toBeUndefined(),
);

it("retains trusted ingress, admin creation, and legacy behavior when the policy is disabled", () => {
  const key = "agent:main:telegram:group:-100123";
  expect(
    authorizeSessionSourceCreation({ cfg, operatorRoleActor: { kind: "system" } }, key),
  ).toBeUndefined();
  expect(
    authorizeSessionSourceCreation(
      { ...operator, requestingOperatorScopes: ["operator.admin"] },
      key,
    ),
  ).toBeUndefined();
  expect(authorizeSessionSourceCreation({ ...operator, cfg: {} }, key)).toBeUndefined();
});

it("uses the current policy at commit rather than a stale disabled snapshot", () => {
  expect(
    authorizeSessionSourceCreation(
      { ...operator, cfg: {}, getCurrentConfig: () => cfg },
      "agent:main:telegram:group:-100123",
    ),
  ).toMatchObject({ code: "FORBIDDEN" });
});
