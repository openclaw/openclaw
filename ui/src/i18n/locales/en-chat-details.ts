import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatDetails = {
  chat: {
    sessionDetails: {
      session: "Session details",
      environment: "Environment",
      context: "Context",
      contextMessages: "Messages & other",
      contextFiles: "Workspace files",
      contextTools: "Tool schemas",
      contextSkills: "Skills catalog",
      contextSystem: "System instructions",
      contextUnverified: "Unverified",
      contextOpen: "View context",
      contextLoading: "Loading context breakdown…",
      contextError: "Couldn’t load the context breakdown. Try again.",
      contextOffline: "Reconnect to load the context breakdown.",
      contextExactCount: "{used} of {limit} tokens",
      worktree: "Worktree",
      changes: "Changes",
      subagents: "Subagents",
      processes: "Processes",
      allSubagents: "All subagents",
      planSteps: "{completed} of {total} steps",
      showMore: "Show {count} more",
      showLess: "Show less",
      stopped: "Stopped",
      tally: {
        done: "{count} done",
        failed: "{count} failed",
        stopped: "{count} stopped",
        running: "{count} running",
        queued: "{count} queued",
      },
      createdBy: "Created by",
      owner: "Owner",
      participants: "{count} participants",
      peopleCount: "People: {count}.",
      moreParticipants: "{count} more participants",
      pullRequests: "Pull requests",
    },
  },
} satisfies TranslationMap;

export const registerChatDetailsEnglish = Object.assign(
  () => Object.assign(en.chat.sessionDetails, enChatDetails.chat.sessionDetails),
  { catalog: enChatDetails },
);
