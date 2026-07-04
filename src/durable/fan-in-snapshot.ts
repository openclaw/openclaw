import { isDurableRuntimesEnabled } from "./config.js";
import { buildDurableFanInGroupId } from "./fan-in.js";
import { buildDurableChildResultMailboxStepId } from "./result-mailbox.js";
import { openDurableRuntimeStore } from "./store-factory.js";
import type {
  DurableRuntimeLink,
  DurableRuntimeRun,
  DurableRuntimeStep,
  DurableRuntimeStore,
} from "./types.js";

const DEFAULT_MAX_SNAPSHOT_CHILDREN = 12;

export type DurableFanInSnapshotChild = {
  runtimeRunId: string;
  childSessionKey?: string;
  status: DurableRuntimeLink["status"];
  terminal: boolean;
  ackStatus?: string;
  deliveryStatus?: string;
  summary?: string;
  error?: string;
  updatedAt: number;
};

export type DurableFanInSnapshot = {
  text: string;
  fanInGroupId: string;
  parentRuntimeRunId: string;
  parentStepId: string;
  total: number;
  terminalCount: number;
  pendingCount: number;
  snapshotTruncated: boolean;
  allListedChildrenTerminal: boolean;
  currentChildOwnsFinal: boolean;
  children: DurableFanInSnapshotChild[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function terminalLink(link: DurableRuntimeLink): boolean {
  return (
    link.status === "succeeded" ||
    link.status === "failed" ||
    link.status === "cancelled" ||
    link.status === "lost"
  );
}

function findCurrentChildRun(params: {
  store: DurableRuntimeStore;
  childRunId: string;
  childSessionKey?: string;
}): DurableRuntimeRun | undefined {
  const childRunId = params.childRunId.trim();
  const childSessionKey = params.childSessionKey?.trim();
  const candidates = params.store.listRuns({ limit: 5000 }).filter((run) => {
    const metadata = isRecord(run.metadata) ? run.metadata : {};
    return (
      run.runtimeRunId === childRunId ||
      run.idempotencyKey === childRunId ||
      (Boolean(childSessionKey) &&
        (run.sourceRef === childSessionKey || metadata.childSessionKey === childSessionKey))
    );
  });
  return candidates.toSorted((a, b) => {
    const score = (run: DurableRuntimeRun): number => {
      if (run.runtimeRunId === childRunId || run.idempotencyKey === childRunId) {
        return 2;
      }
      return 1;
    };
    const scoreDelta = score(b) - score(a);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const updatedDelta = b.updatedAt - a.updatedAt;
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return b.runtimeRunId.localeCompare(a.runtimeRunId);
  })[0];
}

function mailboxForChild(params: {
  store: DurableRuntimeStore;
  parentRuntimeRunId: string;
  childRuntimeRunId: string;
}): DurableRuntimeStep | undefined {
  const stepId = buildDurableChildResultMailboxStepId(params.childRuntimeRunId);
  return params.store
    .listSteps(params.parentRuntimeRunId)
    .find((step) => step.stepId === stepId && step.stepType === "result_mailbox");
}

function childSessionFrom(
  run: DurableRuntimeRun | undefined,
  link: DurableRuntimeLink,
): string | undefined {
  const runMetadata = isRecord(run?.metadata) ? run.metadata : {};
  const linkMetadata = isRecord(link.metadata) ? link.metadata : {};
  return optionalString(runMetadata.childSessionKey, linkMetadata.childSessionKey, run?.sourceRef);
}

function childSummaryFrom(params: {
  run: DurableRuntimeRun | undefined;
  link: DurableRuntimeLink;
  mailbox: DurableRuntimeStep | undefined;
  currentChildRuntimeRunId: string;
  currentFindings?: string;
}): { summary?: string; error?: string; ackStatus?: string; deliveryStatus?: string } {
  const runMetadata = isRecord(params.run?.metadata) ? params.run.metadata : {};
  const linkMetadata = isRecord(params.link.metadata) ? params.link.metadata : {};
  const mailboxMetadata = isRecord(params.mailbox?.metadata) ? params.mailbox.metadata : {};
  const outcome = isRecord(mailboxMetadata.outcome) ? mailboxMetadata.outcome : {};
  const ack = isRecord(mailboxMetadata.ack) ? mailboxMetadata.ack : {};
  const delivery = isRecord(mailboxMetadata.delivery) ? mailboxMetadata.delivery : {};
  const currentFindings =
    params.link.childRuntimeRunId === params.currentChildRuntimeRunId
      ? params.currentFindings
      : undefined;
  return {
    summary: optionalString(
      outcome.summary,
      linkMetadata.summary,
      runMetadata.summary,
      currentFindings,
    ),
    error: optionalString(outcome.error, linkMetadata.error, runMetadata.error),
    ackStatus: optionalString(ack.status),
    deliveryStatus: optionalString(delivery.status),
  };
}

function compareFinalOwner(a: DurableFanInSnapshotChild, b: DurableFanInSnapshotChild): number {
  const updatedDelta = a.updatedAt - b.updatedAt;
  if (updatedDelta !== 0) {
    return updatedDelta;
  }
  return a.runtimeRunId.localeCompare(b.runtimeRunId);
}

function formatSnapshot(params: {
  fanInGroupId: string;
  parentRuntimeRunId: string;
  parentStepId: string;
  children: DurableFanInSnapshotChild[];
  total: number;
  terminalCount: number;
  pendingCount: number;
  snapshotTruncated: boolean;
}): string {
  const childLines = params.children.map((child, index) => {
    const bits = [
      `${index + 1}. ${child.status}`,
      child.childSessionKey ? `session=${child.childSessionKey}` : undefined,
      `run=${child.runtimeRunId}`,
      child.ackStatus ? `ack=${child.ackStatus}` : undefined,
      child.deliveryStatus ? `delivery=${child.deliveryStatus}` : undefined,
    ].filter(Boolean);
    const detail = child.summary || child.error;
    return detail ? `${bits.join(" ")} - ${detail}` : bits.join(" ");
  });
  return [
    "Durable fan-in snapshot (authoritative for this parent fan-in group):",
    `fan_in_group_id: ${params.fanInGroupId}`,
    `parent_runtime_run_id: ${params.parentRuntimeRunId}`,
    `parent_step_id: ${params.parentStepId}`,
    `expected_children: ${params.total}`,
    `terminal_children: ${params.terminalCount}`,
    `pending_children: ${params.pendingCount}`,
    `snapshot_truncated: ${params.snapshotTruncated}`,
    "",
    ...childLines,
  ].join("\n");
}

export function buildDurableFanInSnapshotForChild(params: {
  childRunId: string;
  childSessionKey?: string;
  currentFindings?: string;
  maxChildren?: number;
  env?: NodeJS.ProcessEnv;
}): DurableFanInSnapshot | undefined {
  const env = params.env ?? process.env;
  if (!isDurableRuntimesEnabled(env)) {
    return undefined;
  }
  let store: DurableRuntimeStore | undefined;
  try {
    store = openDurableRuntimeStore({ env });
    const currentChild = findCurrentChildRun({
      store,
      childRunId: params.childRunId,
      childSessionKey: params.childSessionKey,
    });
    if (!currentChild) {
      return undefined;
    }
    const parentLink = store.listParentLinks(currentChild.runtimeRunId)[0];
    if (!parentLink) {
      return undefined;
    }
    const linkMetadata = isRecord(parentLink.metadata) ? parentLink.metadata : {};
    const fanInGroupId =
      optionalString(linkMetadata.fanInGroupId) ??
      buildDurableFanInGroupId({
        parentRuntimeRunId: parentLink.parentRuntimeRunId,
        parentStepId: parentLink.parentStepId,
      });
    const childLinks = store
      .listChildLinks(parentLink.parentRuntimeRunId)
      .filter((link) => {
        if (link.parentStepId !== parentLink.parentStepId) {
          return false;
        }
        const metadata = isRecord(link.metadata) ? link.metadata : {};
        const linkGroupId = optionalString(metadata.fanInGroupId);
        return !linkGroupId || linkGroupId === fanInGroupId;
      })
      .toSorted((a, b) => {
        const updatedDelta = a.updatedAt - b.updatedAt;
        if (updatedDelta !== 0) {
          return updatedDelta;
        }
        return a.childRuntimeRunId.localeCompare(b.childRuntimeRunId);
      });
    if (childLinks.length < 2) {
      return undefined;
    }

    const maxChildren = Math.max(1, params.maxChildren ?? DEFAULT_MAX_SNAPSHOT_CHILDREN);
    const snapshotTruncated = childLinks.length > maxChildren;
    const selectedLinks = childLinks.slice(0, maxChildren);
    const children = selectedLinks.map((link) => {
      const run = store!.getRun(link.childRuntimeRunId);
      const mailbox = mailboxForChild({
        store: store!,
        parentRuntimeRunId: link.parentRuntimeRunId,
        childRuntimeRunId: link.childRuntimeRunId,
      });
      const detail = childSummaryFrom({
        run,
        link,
        mailbox,
        currentChildRuntimeRunId: currentChild.runtimeRunId,
        currentFindings: params.currentFindings,
      });
      return Object.assign(
        {
          runtimeRunId: link.childRuntimeRunId,
          childSessionKey: childSessionFrom(run, link),
          status: link.status,
          terminal: terminalLink(link),
          updatedAt: link.updatedAt,
        },
        detail,
      );
    });
    const terminalChildren = children.filter((child) => child.terminal);
    const terminalCount = terminalChildren.length;
    const pendingCount = Math.max(0, children.length - terminalCount);
    const finalOwner = [...terminalChildren].toSorted(compareFinalOwner).at(-1);
    return {
      text: formatSnapshot({
        fanInGroupId,
        parentRuntimeRunId: parentLink.parentRuntimeRunId,
        parentStepId: parentLink.parentStepId,
        children,
        total: childLinks.length,
        terminalCount,
        pendingCount,
        snapshotTruncated,
      }),
      fanInGroupId,
      parentRuntimeRunId: parentLink.parentRuntimeRunId,
      parentStepId: parentLink.parentStepId,
      total: childLinks.length,
      terminalCount,
      pendingCount,
      snapshotTruncated,
      allListedChildrenTerminal: pendingCount === 0,
      currentChildOwnsFinal: finalOwner?.runtimeRunId === currentChild.runtimeRunId,
      children,
    };
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}
