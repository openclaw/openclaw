import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  sessionFolders: {
    openFolder: "Open {name} folder",
    title: "Folders",
    description:
      "A shared place for related threads, personal briefings and their source artifacts.",
    newFolder: "New folder",
    projectFolder: "Project folder",
    threadCount: "{count} threads",
    noFolders: "Create a folder to bring related threads together.",
    threads: "Threads",
    running: "Running",
    idle: "Idle",
    pinned: "Pinned",
    accessUnchanged: "Organizing threads does not change who can access them.",
    newThread: "New thread in this folder",
    overview: "Overview",
    context: "Context & artifacts",
    statusCaveat:
      "Run status is not project completion. A finished agent may still be waiting on a review.",
    moveHint: "Move threads without changing access",
    moveThread: "Move {name} to folder",
    pin: "Pin for me",
    unpin: "Unpin",
    savedBrief: "Where we are · personal",
    briefSource:
      "Saved progress from your pinned thread. Open its conversation for the full evidence.",
    noBrief: "This thread has no saved progress card yet.",
    briefUnavailable:
      "Saved progress could not be loaded. Open the source thread to check access or retry.",
    continueThread: "Continue in thread",
    pinHint: "Pin the coordinator or handoff thread to keep its durable progress here.",
    coordinator: "One place to coordinate",
    coordinatorHint:
      "Use a thread in this folder as the coordinator. Its saved progress survives the run; the original conversations remain the source of truth.",
    contextDescription:
      "Your pinned source threads provide durable context. Folder membership does not inject content into other conversations.",
    artifacts: "Artifacts by source",
    artifactDescription:
      "Open a source thread to inspect its files and outputs. Each artifact retains the thread's access and provenance.",
    sourceThread: "Files & outputs in thread",
    empty: "No visible threads in this folder. Move a thread here or start one.",
    coverage:
      "Showing threads in the loaded session list. Existing session visibility still applies.",
    allThreads: "All threads",
  },
} satisfies TranslationMap;

export const registerSessionFoldersEnglish = Object.assign(
  () => {
    Object.assign(en, catalog);
  },
  { catalog },
);
