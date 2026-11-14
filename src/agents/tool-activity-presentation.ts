import type { AgentItemEventData } from "../infra/agent-activity-events.js";

type CompletedCall = { toolCallId?: string; activity?: AgentItemEventData };
type ActivityNode = {
  started: boolean;
  parent?: ActivityNode;
  children: Set<ActivityNode>;
  shownChildren: number;
  shown: boolean;
  call?: CompletedCall;
};

/** One live run's recorded nesting; history continues to group its immutable snapshot. */
export class ToolActivityPresentation {
  private readonly nodes = new Map<string, ActivityNode | null>();
  private readonly changed = new Set<ActivityNode>();

  private node(id: string): ActivityNode | null {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, {
        started: false,
        children: new Set(),
        shownChildren: 0,
        shown: false,
      });
    }
    return this.nodes.get(id)!;
  }

  start(id: string, parentId?: string): void {
    const node = this.node(id);
    if (!node) {
      return;
    }
    if (node.started) {
      // Reused identities cannot supply either end of a recorded nesting edge.
      this.detach(node);
      for (const child of node.children) {
        this.detach(child);
      }
      this.changed.delete(node);
      this.nodes.set(id, null);
      return;
    }
    node.started = true;
    const parent = parentId && parentId !== id ? this.node(parentId) : undefined;
    if (!parent) {
      return;
    }
    node.parent = parent;
    parent.children.add(node);
    parent.shownChildren += Number(node.shown);
    // A late parent can close a malformed cycle. As in groupToolCalls, detach
    // every cycle member, while preserving children outside that cycle.
    let ancestor: ActivityNode | undefined = node.children.size > 0 ? parent : undefined;
    while (ancestor && ancestor !== node) {
      ancestor = ancestor.parent;
    }
    if (ancestor) {
      let member = node;
      do {
        const next = member.parent!;
        this.detach(member);
        member = next;
      } while (member !== node);
    } else {
      this.refresh(parent);
    }
  }

  private detach(node: ActivityNode): void {
    const parent = node.parent;
    if (parent) {
      node.parent = undefined;
      parent.children.delete(node);
      parent.shownChildren -= Number(node.shown);
      this.refresh(parent);
    }
  }

  private refresh(node: ActivityNode): void {
    for (let current: ActivityNode | undefined = node; current; current = current.parent) {
      const activity = current.call?.activity;
      if (
        current.shownChildren > 0 &&
        activity?.status === "completed" &&
        !activity.hideFromChannelProgress
      ) {
        this.changed.add(current);
      }
      const shown =
        current.shownChildren > 0 ||
        Boolean(activity && !activity.hideFromChannelProgress && !activity.suppressChannelProgress);
      if (shown === current.shown) {
        break;
      }
      current.shown = shown;
      if (current.parent) {
        current.parent.shownChildren += shown ? 1 : -1;
      }
    }
  }

  complete(call: CompletedCall): void {
    const node = call.toolCallId ? this.nodes.get(call.toolCallId) : undefined;
    if (node) {
      node.call = call;
      this.refresh(node);
    }
  }

  *drain(): Iterable<AgentItemEventData> {
    for (const node of this.changed) {
      const call = node.call;
      if (
        node.shownChildren > 0 &&
        call?.activity?.status === "completed" &&
        !call.activity.hideFromChannelProgress
      ) {
        // Published events stay immutable; the terminal metadata owns the replacement.
        call.activity = { ...call.activity, hideFromChannelProgress: true };
        yield call.activity;
      }
    }
    this.changed.clear();
  }
}
