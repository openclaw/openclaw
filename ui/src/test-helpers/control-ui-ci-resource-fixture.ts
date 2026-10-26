import type { ChatCiDetailsElement } from "../pages/chat/components/chat-ci-details.tsx";
import { observe, publish } from "./control-ui-card-resource-shared.ts";
import {
  instanceAssert as assert,
  instanceGateway,
  instanceSettle as settle,
  instanceWait as wait,
  type InstanceContext,
  type InstanceGroup,
} from "./control-ui-instance-resource-fixture.ts";
const pr = {
  owner: "example",
  repo: "synthetic",
  number: 42,
  branch: "fixture",
  title: "Synthetic CI fixture",
  state: "open" as const,
  url: "https://github.com/example/synthetic/pull/42",
  headSha: "a".repeat(40),
};
function checkResult(name: string) {
  return {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    headSha: pr.headSha,
    status: "ready",
    rateLimited: false,
    checks: [{ id: 1, name, source: "actions", state: "failed", status: "completed", steps: [] }],
  };
}

export async function createInstanceConsumers(context: InstanceContext) {
  await Promise.all([
    import("../pages/chat/components/chat-ci-details.tsx"),
    import("../pages/chat/components/chat-ci-automation-control.tsx"),
  ]);
  const rows: {
    group: InstanceGroup;
    root: HTMLDetailsElement;
    detail: ChatCiDetailsElement;
    automation: HTMLElement;
  }[] = [];
  return {
    async setup() {
      instanceGateway().setMethodResponse(
        "controlUi.sessionPullRequests.checks",
        checkResult("Accepted synthetic check"),
      );
      for (const [label, count] of [
        ["A", 100],
        ["B", 30],
      ] as const) {
        const group = await context.group(label, count);
        observe(context, group);
        context.capture(`${label}:before-consumers`);
        for (let index = 0; index < count; index++) {
          const root = document.createElement("details");
          root.className = "chat-pr__checks";
          const summary = document.createElement("summary");
          summary.textContent = `${label} synthetic CI ${index}`;
          const detail = document.createElement("openclaw-chat-ci-details");
          const automation = document.createElement("openclaw-chat-ci-automation");
          const props = {
            gateway: group.runtime.context.gateway,
            pullRequest: pr,
            sessionKey: `agent:main:instance-ci-${label}`,
            presented: true,
          };
          Object.assign(detail, props);
          Object.assign(automation, props, { sessionId: `instance-ci-${label}` });
          root.append(summary, detail, automation);
          group.root.append(root);
          rows.push({ group, root, detail, automation });
        }
        await Promise.all(
          rows.filter((row) => row.group === group).map((row) => row.detail.updateComplete),
        );
        await settle();
        context.recordMounted(group, group.root.querySelectorAll(".chat-pr__checks").length);
        assert(
          group.root.querySelectorAll("openclaw-chat-ci-automation").length === count,
          "CI fixture did not mount real automation elements",
        );
        context.capture(`${label}:closed-CI-pairs`);
      }
      return context.result();
    },
    async run() {
      const retained = rows.flatMap((row) => [row.root, row.detail, row.automation]);
      const requests = instanceGateway().findRequests(
        "controlUi.sessionPullRequests.checks",
      ).length;
      const other = context.groups[1]!.root.innerHTML;
      await publish(context);
      assert(
        retained.every((node) => node.isConnected),
        "Closed CI publication replaced mounted consumers",
      );
      assert(context.groups[1]!.root.innerHTML === other, "A native snapshot changed B CI output");
      assert(
        instanceGateway().findRequests("controlUi.sessionPullRequests.checks").length === requests,
        "Closed CI snapshot started a details request",
      );
      context.facts.assertions.push(
        "100 A / 30 B real closed details/automation pairs; 20 native A Gateway snapshots; unchanged B and no closed details reads",
      );
      return context.result();
    },
    async finish() {
      const first = rows[0]!;
      const key = first.detail.sessionKey;
      const gateway = first.group.runtime.context.gateway;
      instanceGateway().deferNext("controlUi.sessionPullRequests.checks", { sessionKey: key });
      const requests = instanceGateway().findRequests("controlUi.sessionPullRequests.checks", {
        sessionKey: key,
      }).length;
      first.root.open = true;
      await wait(
        () =>
          instanceGateway().findRequests("controlUi.sessionPullRequests.checks", {
            sessionKey: key,
          }).length ===
          requests + 1,
        "Opening CI did not enter the native request boundary",
      );
      context.capture("one-open-pending-CI");
      gateway.stop();
      assert(
        gateway.snapshot.phase !== "connected",
        "Native CI Gateway stop did not revoke admission",
      );
      first.root.open = false;
      instanceGateway().resolveDeferred(
        "controlUi.sessionPullRequests.checks",
        checkResult("RETIRED CI RESULT"),
        { match: { sessionKey: key } },
      );
      await settle();
      assert(
        !first.detail.textContent?.includes("RETIRED CI RESULT"),
        "Retired CI result reached rendered details",
      );
      gateway.start();
      await wait(
        () => gateway.snapshot.phase === "connected",
        "Native CI Gateway did not reconnect",
      );
      first.root.open = true;
      await wait(
        () => first.detail.textContent?.includes("Accepted synthetic check"),
        "Live reconnect did not render accepted CI result",
      );
      context.capture("one-open-current-CI");
      first.root.open = false;
      for (const row of rows.filter((candidate) => candidate.group.label === "A").slice(1)) {
        row.root.remove();
      }
      await settle();
      context.capture("one-A-and-all-B-remain");
      assert(
        rows.filter((row) => row.group.label === "B").every((row) => row.root.isConnected),
        "CI cleanup retired another application",
      );
      for (const row of rows) {
        row.root.remove();
      }
      await settle();
      context.capture("retired-all");
      const counts = context.probe?.sources.snapshot();
      if (counts) {
        assert(
          Object.values(counts.sources).every((source) => source.active === 0),
          "Native CI subscriptions survived consumer disposal",
        );
      }
      context.facts.assertions.push(
        "Real disclosure open, native pending request, synchronous Gateway stop, retired transport response (the closed native socket drops this reply), reconnect and accepted response; independent cleanup",
      );
      return context.result();
    },
  };
}
