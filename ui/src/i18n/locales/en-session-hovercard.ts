import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionHovercard = {
  sessionHovercard: {
    ariaLabel: en.sessionHovercard.ariaLabel,
    agentNotepad: "Task progress",
    linkedChannel: en.sessionHovercard.linkedChannel,
    viaAccount: "Via {account}",
    topicNumber: "Topic {id}",
    sessionParticipants: "In this session",
    chatKinds: {
      direct: "Direct chat",
      group: "Group chat",
      channel: "Channel",
      thread: "Thread",
      topic: "Topic",
    },
    attributionOther: "& {count} other",
    attributionOthers: "& {count} others",
    moreParticipants: en.sessionHovercard.moreParticipants,
    moreParticipantsLabel: en.sessionHovercard.moreParticipantsLabel,
    projectLabel: en.sessionHovercard.projectLabel,
    workspaceLabel: en.sessionHovercard.workspaceLabel,
    automationCount: "{count} automations",
    selectAutomation: "Select an automation",
    automationInstructions: "Instructions",
    automationFullInstructions: "Full instructions",
    openAutomation: "Open automation",
    openAutomations: "Open automations",
    automationNext: "Next {time}",
    automationLast: "Last run {status} · {time}",
    automationStatuses: {
      ok: "succeeded",
      error: "failed",
      skipped: "skipped",
      unknown: "status unknown",
    },
    branchLabel: en.sessionHovercard.branchLabel,
    runsOn: en.sessionHovercard.runsOn,
    machineCpu: en.sessionHovercard.machineCpu,
    machineMemory: en.sessionHovercard.machineMemory,
    more: en.sessionHovercard.more,
    changedFile: en.sessionHovercard.changedFile,
    changedFiles: en.sessionHovercard.changedFiles,
  },
} satisfies TranslationMap;

export const registerSessionHovercardEnglish = Object.assign(
  () => {
    Object.assign(en.sessionHovercard, enSessionHovercard.sessionHovercard);
  },
  { catalog: enSessionHovercard },
);
