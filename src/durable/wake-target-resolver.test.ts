import { describe, expect, it } from "vitest";
import {
  resolveDurableWakeTarget,
  type DurableWakeTargetCandidate,
} from "./wake-target-resolver.js";

function target(
  ref: string,
  overrides: Partial<DurableWakeTargetCandidate> = {},
): DurableWakeTargetCandidate {
  return {
    kind: "agent_session",
    ref,
    ownerKind: "agent_session",
    ownerRef: ref,
    sessionKey: ref,
    ...overrides,
  };
}

describe("durable wake target resolver", () => {
  it("targets a direct single-agent turn owner", () => {
    expect(
      resolveDurableWakeTarget({
        directTurnOwner: target("agent:main:session"),
      }),
    ).toMatchObject({
      status: "resolved",
      targetKind: "agent_session",
      targetRef: "agent:main:session",
      ownerKind: "agent_session",
      ownerRef: "agent:main:session",
      resolutionReason: "direct_turn_owner",
    });
  });

  it("prefers an explicit work owner over lower-precedence routes", () => {
    expect(
      resolveDurableWakeTarget({
        explicitWorkOwners: [target("agent:owner:session")],
        directTurnOwner: target("agent:turn:session"),
        reportRoute: target("discord:thread:1", {
          kind: "channel_route",
          reportRouteRef: "discord:thread:1",
        }),
      }),
    ).toMatchObject({
      status: "resolved",
      targetRef: "agent:owner:session",
      resolutionReason: "explicit_work_owner",
    });
  });

  it("uses subagent delegation parent or supervisor facts", () => {
    expect(
      resolveDurableWakeTarget({
        delegations: [
          {
            kind: "subagent_child",
            parent: target("agent:parent:session"),
            supervisor: target("agent:supervisor:session"),
          },
        ],
      }),
    ).toMatchObject({
      status: "resolved",
      targetRef: "agent:parent:session",
      resolutionReason: "delegation_subagent_child",
    });
  });

  it("uses peer delegation coordinator before delegator", () => {
    expect(
      resolveDurableWakeTarget({
        delegations: [
          {
            kind: "peer_delegation",
            coordinator: target("agent:coordinator:session"),
            delegator: target("agent:delegator:session"),
          },
        ],
      }),
    ).toMatchObject({
      status: "resolved",
      targetRef: "agent:coordinator:session",
      resolutionReason: "delegation_peer_delegation",
    });
  });

  it("targets scheduled taskflow or background owners before report routes", () => {
    expect(
      resolveDurableWakeTarget({
        scheduledOwner: target("taskflow:daily-digest", {
          kind: "taskflow",
          ownerKind: "taskflow",
          ownerRef: "taskflow:daily-digest",
        }),
        reportRoute: target("discord:ops-thread", {
          kind: "channel_route",
          reportRouteRef: "discord:ops-thread",
        }),
      }),
    ).toMatchObject({
      status: "resolved",
      targetKind: "taskflow",
      targetRef: "taskflow:daily-digest",
      ownerKind: "taskflow",
      resolutionReason: "scheduled_or_background_owner",
    });
  });

  it("falls back when a recorded parent is no longer live", () => {
    const resolved = resolveDurableWakeTarget({
      delegations: [
        {
          kind: "subagent_child",
          parent: target("agent:parent:gone", { live: false }),
        },
      ],
      rootOwner: target("agent:root:session"),
    });

    expect(resolved).toMatchObject({
      status: "resolved",
      targetRef: "agent:root:session",
      resolutionReason: "root_owner_fallback",
    });
    expect(resolved.diagnostics).toContain("delegation_subagent_child: no live authorized target");
  });

  it("routes missing owners to an inspect-only operator obligation", () => {
    expect(
      resolveDurableWakeTarget({
        operatorRoute: target("operator:durable", {
          kind: "operator",
          ownerKind: "operator",
          ownerRef: "operator:durable",
        }),
      }),
    ).toMatchObject({
      status: "inspect_only",
      targetKind: "operator",
      targetRef: "operator:durable",
      resolutionReason: "operator_inspect_only_fallback",
    });
  });

  it("marks ambiguous owners unresolved for operator inspection", () => {
    expect(
      resolveDurableWakeTarget({
        explicitWorkOwners: [target("agent:owner:a"), target("agent:owner:b")],
        operatorRoute: target("operator:durable", {
          kind: "operator",
          ownerKind: "operator",
          ownerRef: "operator:durable",
        }),
      }),
    ).toMatchObject({
      status: "ambiguous",
      targetKind: "operator",
      targetRef: "operator:durable",
      resolutionReason: "explicit_work_owner_ambiguous",
    });
  });

  it("marks unauthorized owners unresolved for operator inspection", () => {
    expect(
      resolveDurableWakeTarget({
        explicitWorkOwners: [target("agent:owner:forbidden", { authorized: false })],
        operatorRoute: target("operator:durable", {
          kind: "operator",
          ownerKind: "operator",
          ownerRef: "operator:durable",
        }),
      }),
    ).toMatchObject({
      status: "unauthorized",
      targetKind: "operator",
      targetRef: "operator:durable",
      resolutionReason: "explicit_work_owner_unauthorized",
    });
  });

  it("targets an authorized external report route", () => {
    expect(
      resolveDurableWakeTarget({
        reportRoute: target("slack:channel:C123:thread:456", {
          kind: "external_route",
          ownerKind: "external_route",
          ownerRef: "slack:channel:C123",
          reportRouteRef: "slack:channel:C123:thread:456",
          external: true,
        }),
      }),
    ).toMatchObject({
      status: "resolved",
      targetKind: "external_route",
      targetRef: "slack:channel:C123:thread:456",
      ownerKind: "external_route",
      reportRouteRef: "slack:channel:C123:thread:456",
      resolutionReason: "report_route",
    });
  });
});
