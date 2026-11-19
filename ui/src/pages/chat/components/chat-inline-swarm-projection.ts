import { resolveSessionDisplayName } from "../../../lib/session-display.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { isSubagentsPanelSession } from "../chat-spawned-subagent.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import type { InlineSwarm } from "./chat-inline-swarm.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

export function projectInlineSwarms(
  props: Pick<ChatThreadProps, "subagentParentKey" | "subagentSessions">,
  rows: readonly TranscriptRow<SystemEventRenderItem>[],
  liveItem: SystemEventRenderItem | undefined,
  searchFiltering: boolean,
  onOpenChild: InlineSwarm["onOpenChild"],
) {
  const parent =
    props.subagentParentKey &&
    props.subagentSessions?.find(
      (row) => row.swarm && areUiSessionKeysEquivalent(row.key, props.subagentParentKey),
    );
  const swarms = new Map<string, { view: InlineSwarm; signature: string }>();
  if (parent && !searchFiltering && parent.swarm?.groups.length) {
    const labels = new Map(
      props.subagentSessions
        ?.filter((row) => row.swarmGroupId && isSubagentsPanelSession(row))
        .map((row) => [row.key, resolveSessionDisplayName(row.key, row)]),
    );
    for (const group of parent.swarm.groups) {
      const childLabels = group.children?.map((child) => labels.get(child.sessionKey));
      swarms.set(group.groupId, {
        view: { group, labels, onOpenChild },
        signature: JSON.stringify([group, childLabels]),
      });
    }
  }
  // Explicit shared group IDs are not turn identities. Never infer ownership by time.
  const swarmsByFrame = new Map<string, { views: InlineSwarm[]; signature: string }>();
  if (parent && swarms.size) {
    for (const row of rows) {
      if (row.kind !== "item") {
        continue;
      }
      const item = row.key === liveItem?.key ? liveItem : row.item;
      if (item.kind !== "agent-run-frame" || (item.fragment && !item.fragment.first)) {
        continue;
      }
      const runIds = item.handoffRunIds ? [...item.handoffRunIds, item.runId] : [item.runId];
      const matches = runIds.flatMap((runId) => {
        const id = `swarm:${parent.key}:${runId}`;
        const swarm = swarms.get(id);
        if (!swarm) {
          return [];
        }
        swarms.delete(id);
        return [swarm];
      });
      if (matches.length) {
        swarmsByFrame.set(item.key, {
          views: matches.map((swarm) => swarm.view),
          signature: JSON.stringify(matches.map((swarm) => swarm.signature)),
        });
      }
      if (!swarms.size) {
        break;
      }
    }
  }
  return swarmsByFrame;
}
