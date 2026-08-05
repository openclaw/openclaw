import type { MeetingBrowserTab } from "./session-types.js";

export type MeetingRetainedBrowserTab<TSession, TTab> = {
  session: TSession;
  tab: TTab;
};

export function inheritMeetingBrowserTabOwnership<
  TTransport extends string,
  TSession extends { transport: TTransport; url: string },
  TTab extends MeetingBrowserTab,
>(params: {
  getBrowser(session: TSession): { nodeId?: string; tab?: TTab } | undefined;
  meetingUrl: string;
  nodeId?: string;
  sameMeetingUrl(left: string | undefined, right: string | undefined): boolean;
  sessions: Iterable<TSession>;
  tab?: TTab;
  transport: TTransport;
}): TTab | undefined {
  if (!params.tab) {
    return undefined;
  }
  const inherited = [...params.sessions].some((session) => {
    const browser = params.getBrowser(session);
    return (
      session.transport === params.transport &&
      params.sameMeetingUrl(session.url, params.meetingUrl) &&
      browser?.nodeId === params.nodeId &&
      browser?.tab?.targetId === params.tab?.targetId &&
      browser?.tab?.openedByPlugin === true
    );
  });
  return inherited ? { ...params.tab, openedByPlugin: true } : params.tab;
}

export async function settleRetainedMeetingBrowserTabs<
  TTransport extends string,
  TSession extends { transport: TTransport },
  TTab extends MeetingBrowserTab,
>(params: {
  adopted?: { transport: TTransport; nodeId?: string; tab: TTab };
  getBrowser(session: TSession): { nodeId?: string } | undefined;
  releaseBrowserTab(session: TSession): Promise<boolean | undefined>;
  retained: Array<MeetingRetainedBrowserTab<TSession, TTab>>;
  setBrowserTab(session: TSession, tab: TTab | undefined): void;
}): Promise<boolean> {
  let settled = true;
  for (let index = 0; index < params.retained.length;) {
    const retainedTab = params.retained[index];
    if (!retainedTab) {
      break;
    }
    const { session, tab } = retainedTab;
    const browser = params.getBrowser(session);
    const adoptedThisTab =
      params.adopted?.transport === session.transport &&
      params.adopted.nodeId === browser?.nodeId &&
      params.adopted.tab.targetId === tab.targetId;
    if (adoptedThisTab) {
      params.setBrowserTab(session, undefined);
      params.retained.splice(index, 1);
      continue;
    }
    if ((await params.releaseBrowserTab(session)) === false) {
      settled = false;
      index += 1;
      continue;
    }
    // Consume only after settlement succeeds. A rejection leaves this entry and the
    // remaining tail available to the failed-join rollback path for another attempt.
    params.retained.splice(index, 1);
  }
  return settled;
}

export async function settleRetainedMeetingBrowserTabsAfterFailure(params: {
  formatError(error: unknown): string;
  retained: readonly unknown[];
  settle(): Promise<boolean>;
  warn(message: string): void;
}): Promise<void> {
  // Failed reassignment has no future owner for retained tabs. Try twice while
  // preserving entries between attempts, but never replace the original join error.
  for (let attempt = 0; attempt < 2 && params.retained.length > 0; attempt += 1) {
    try {
      if (await params.settle()) {
        return;
      }
    } catch (error) {
      params.warn(`retained browser cleanup failed: ${params.formatError(error)}`);
    }
  }
  if (params.retained.length > 0) {
    params.warn("retained browser cleanup incomplete after failed join");
  }
}
