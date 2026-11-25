import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatToolOperations = {
  chat: {
    toolCards: {
      operationUnknown: "{action} · outcome unknown",
      operationNoResult: "{action} · no result recorded",
      operationBlocked: "{action} · blocked",
      namedOperation: "{action} · {name}",
      listingChats: "Listing chats",
      listedChats: "Listed chats",
      listChats: "List chats",
      selectingTools: "Selecting tools",
      selectedTools: "Selected tools",
      selectTools: "Select tools",
      searchingTools: "Searching tools",
      searchedTools: "Searched tools",
      searchTools: "Search tools",
      conversationDelivery: {
        sent: "Sent to conversation",
        queued: "Message queued",
        suppressed: "Message not sent",
        unknown: "Delivery unconfirmed",
        replied: "Sent · reply received",
        timeout: "Sent · reply timed out",
      },
      operationLabels: {
        ls: {
          default: { action: "List files", running: "Listing files", done: "Listed files" },
        },
        process: {
          list: {
            action: "List processes",
            running: "Listing processes",
            done: "Listed processes",
          },
          poll: { action: "Check process", running: "Checking process", done: "Checked process" },
          log: {
            action: "Read process log",
            running: "Reading process log",
            done: "Read process log",
          },
          write: {
            action: "Write to process",
            running: "Writing to process",
            done: "Wrote to process",
          },
          "send-keys": {
            action: "Send keys to process",
            running: "Sending keys to process",
            done: "Sent keys to process",
          },
          submit: {
            action: "Submit process input",
            running: "Submitting process input",
            done: "Submitted process input",
          },
          paste: {
            action: "Paste into process",
            running: "Pasting into process",
            done: "Pasted into process",
          },
          kill: {
            action: "Request process stop",
            running: "Requesting process stop",
            done: "Requested process stop",
          },
          clear: {
            action: "Remove finished process record",
            running: "Removing finished process record",
            done: "Removed finished process record",
          },
          remove: {
            action: "Remove process record",
            running: "Removing process record",
            done: "Removed process record",
          },
        },
        code_execution: {
          default: { action: "Run code", running: "Running code", done: "Ran code" },
        },
        secrets: {
          request: {
            action: "Request secret",
            running: "Requesting secret",
            done: "Requested secret",
          },
          list: {
            action: "List secret names",
            running: "Listing secret names",
            done: "Listed secret names",
          },
          delete: { action: "Delete secret", running: "Deleting secret", done: "Deleted secret" },
        },
        search: {
          default: { action: "Search files", running: "Searching files", done: "Searched files" },
        },
        find: {
          default: { action: "Find files", running: "Finding files", done: "Found files" },
        },
        grep: {
          default: {
            action: "Search file contents",
            running: "Searching file contents",
            done: "Searched file contents",
          },
        },
        glob: {
          default: { action: "Find files", running: "Finding files", done: "Found files" },
        },
        crabbox: {
          profiles: {
            action: "List Crabbox profiles",
            running: "Listing Crabbox profiles",
            done: "Listed Crabbox profiles",
          },
          create: {
            action: "Create Crabbox",
            running: "Creating Crabbox",
            done: "Created Crabbox",
          },
          status: { action: "Check Crabbox", running: "Checking Crabbox", done: "Checked Crabbox" },
          exec: {
            action: "Run command in Crabbox",
            running: "Running command in Crabbox",
            done: "Ran command in Crabbox",
          },
          process_status: {
            action: "Check Crabbox process",
            running: "Checking Crabbox process",
            done: "Checked Crabbox process",
          },
          process_stop: {
            action: "Stop Crabbox process",
            running: "Stopping Crabbox process",
            done: "Stopped Crabbox process",
          },
          stop: { action: "Stop Crabbox", running: "Stopping Crabbox", done: "Stopped Crabbox" },
        },
        diffs: {
          default: {
            action: "Show file differences",
            running: "Showing file differences",
            done: "Showed file differences",
          },
        },
        file_fetch: {
          default: { action: "Fetch file", running: "Fetching file", done: "Fetched file" },
        },
        dir_list: {
          default: {
            action: "List directory",
            running: "Listing directory",
            done: "Listed directory",
          },
        },
        dir_fetch: {
          default: {
            action: "Fetch directory",
            running: "Fetching directory",
            done: "Fetched directory",
          },
        },
        file_write: {
          default: { action: "Write file", running: "Writing file", done: "Wrote file" },
        },
        qa_restart_wait: {
          default: {
            action: "Wait through restart",
            running: "Waiting through restart",
            done: "Waited through restart",
          },
        },
        decision_evaluate: {
          default: {
            action: "Evaluate criteria",
            running: "Evaluating criteria",
            done: "Evaluated criteria",
          },
        },
        presence: {
          list: { action: "List presence", running: "Listing presence", done: "Listed presence" },
          person: {
            action: "Read person presence",
            running: "Reading person presence",
            done: "Read person presence",
          },
          device: {
            action: "Read device presence",
            running: "Reading device presence",
            done: "Read device presence",
          },
        },
        sessions: {
          patch: { action: "Update chat", running: "Updating chat", done: "Updated chat" },
          group_list: {
            action: "List chat groups",
            running: "Listing chat groups",
            done: "Listed chat groups",
          },
          group_set: {
            action: "Set chat group",
            running: "Setting chat group",
            done: "Set chat group",
          },
          group_rename: {
            action: "Rename chat group",
            running: "Renaming chat group",
            done: "Renamed chat group",
          },
          group_delete: {
            action: "Delete chat group",
            running: "Deleting chat group",
            done: "Deleted chat group",
          },
        },
        sessions_create: {
          default: { action: "Create chat", running: "Creating chat", done: "Created chat" },
        },
        conversations_list: {
          default: {
            action: "List conversations",
            running: "Listing conversations",
            done: "Listed conversations",
          },
        },
        conversations_send: {
          default: {
            action: "Send to conversation",
            running: "Sending to conversation",
          },
        },
        conversations_turn: {
          default: {
            action: "Send and wait for a reply",
            running: "Sending and waiting for a reply",
          },
        },
        github_identity_status: {
          default: {
            action: "Check GitHub identity",
            running: "Checking GitHub identity",
            done: "Checked GitHub identity",
          },
        },
        github_publish: {
          publish: {
            action: "Publish GitHub changes",
            running: "Publishing GitHub changes",
            done: "Published GitHub changes",
          },
          readiness: {
            action: "Check publication readiness",
            running: "Checking publication readiness",
            done: "Checked publication readiness",
          },
          inspect_pr: {
            action: "Inspect pull request",
            running: "Inspecting pull request",
            done: "Inspected pull request",
          },
          create_issue: {
            action: "Create GitHub issue",
            running: "Creating GitHub issue",
            done: "Created GitHub issue",
          },
          prepare_pr: {
            action: "Prepare pull request",
            running: "Preparing pull request",
            done: "Prepared pull request",
          },
          refresh_base: {
            action: "Refresh pull request base",
            running: "Refreshing pull request base",
            done: "Refreshed pull request base",
          },
          edit: {
            action: "Edit pull request",
            running: "Editing pull request",
            done: "Edited pull request",
          },
          ready: {
            action: "Mark pull request ready",
            running: "Marking pull request ready",
            done: "Marked pull request ready",
          },
          request_review: {
            action: "Request review",
            running: "Requesting review",
            done: "Requested review",
          },
          upload_evidence: {
            action: "Upload review evidence",
            running: "Uploading review evidence",
            done: "Uploaded review evidence",
          },
        },
        session_project: {
          list: { action: "List projects", running: "Listing projects", done: "Listed projects" },
          move: {
            action: "Move chat to project",
            running: "Moving chat to project",
            done: "Moved chat to project",
          },
        },
        subagents: {
          wait: {
            action: "Wait for subagents",
            running: "Waiting for subagents",
            done: "Waited for subagents",
          },
        },
        session_status: {
          default: {
            action: "Check chat status",
            running: "Checking chat status",
            done: "Checked chat status",
          },
        },
        suggest_task: {
          default: { action: "Suggest task", running: "Suggesting task", done: "Suggested task" },
        },
        dismiss_task: {
          default: { action: "Dismiss task", running: "Dismissing task", done: "Dismissed task" },
        },
        agents_list: {
          default: { action: "List agents", running: "Listing agents", done: "Listed agents" },
        },
        create_goal: {
          default: { action: "Create goal", running: "Creating goal", done: "Created goal" },
        },
        update_goal: {
          default: { action: "Update goal", running: "Updating goal", done: "Updated goal" },
          status_complete: {
            action: "Mark goal complete",
            running: "Marking goal complete",
            done: "Marked goal complete",
          },
          status_paused: { action: "Pause goal", running: "Pausing goal", done: "Paused goal" },
          status_blocked: {
            action: "Mark goal blocked",
            running: "Marking goal blocked",
            done: "Marked goal blocked",
          },
        },
        skill_workshop: {
          list: {
            action: "List workspace skills",
            running: "Listing workspace skills",
            done: "Listed workspace skills",
          },
          view: {
            action: "Read workspace skill",
            running: "Reading workspace skill",
            done: "Read workspace skill",
          },
          create: {
            action: "Create workspace skill",
            running: "Creating workspace skill",
            done: "Created workspace skill",
          },
          patch: {
            action: "Patch workspace skill",
            running: "Patching workspace skill",
            done: "Patched workspace skill",
          },
          write_file: {
            action: "Write skill file",
            running: "Writing skill file",
            done: "Wrote skill file",
          },
          remove_file: {
            action: "Remove skill file",
            running: "Removing skill file",
            done: "Removed skill file",
          },
          archive: { action: "Archive skill", running: "Archiving skill", done: "Archived skill" },
          restore: { action: "Restore skill", running: "Restoring skill", done: "Restored skill" },
          draft: {
            action: "Draft skill changes",
            running: "Drafting skill changes",
            done: "Drafted skill changes",
          },
          discard: {
            action: "Discard skill draft",
            running: "Discarding skill draft",
            done: "Discarded skill draft",
          },
        },
        skill_library: {
          list: {
            action: "List library skills",
            running: "Listing library skills",
            done: "Listed library skills",
          },
          read: {
            action: "Read library skill",
            running: "Reading library skill",
            done: "Read library skill",
          },
          create: {
            action: "Create library skill",
            running: "Creating library skill",
            done: "Created library skill",
          },
          update: {
            action: "Update library skill",
            running: "Updating library skill",
            done: "Updated library skill",
          },
          share: { action: "Share skill", running: "Sharing skill", done: "Shared skill" },
          unshare: {
            action: "Stop sharing skill",
            running: "Stopping sharing skill",
            done: "Stopped sharing skill",
          },
          transfer: {
            action: "Transfer skill",
            running: "Transferring skill",
            done: "Transferred skill",
          },
          activate: {
            action: "Activate skill",
            running: "Activating skill",
            done: "Activated skill",
          },
          remove: {
            action: "Remove library skill",
            running: "Removing library skill",
            done: "Removed library skill",
          },
          rollback: {
            action: "Restore skill version",
            running: "Restoring skill version",
            done: "Restored skill version",
          },
        },
        tool_describe: {
          default: {
            action: "Read tool instructions",
            running: "Reading tool instructions",
            done: "Read tool instructions",
          },
        },
        codex_threads: {
          default: {
            action: "Manage Codex chats",
            running: "Managing Codex chats",
            done: "Managed Codex chats",
          },
          list: {
            action: "List Codex chats",
            running: "Listing Codex chats",
            done: "Listed Codex chats",
          },
          read: {
            action: "Read Codex chat",
            running: "Reading Codex chat",
            done: "Read Codex chat",
          },
          fork: {
            action: "Fork Codex chat",
            running: "Forking Codex chat",
            done: "Forked Codex chat",
          },
          rename: {
            action: "Rename Codex chat",
            running: "Renaming Codex chat",
            done: "Renamed Codex chat",
          },
          archive: {
            action: "Archive Codex chat",
            running: "Archiving Codex chat",
            done: "Archived Codex chat",
          },
          unarchive: {
            action: "Restore Codex chat",
            running: "Restoring Codex chat",
            done: "Restored Codex chat",
          },
        },
        codex_plugins: {
          default: {
            action: "List Codex plugins",
            running: "Listing Codex plugins",
            done: "Listed Codex plugins",
          },
        },
        codex_endpoint_probe: {
          default: {
            action: "Check Codex connection",
            running: "Checking Codex connection",
            done: "Checked Codex connection",
          },
        },
        codex_sessions_list: {
          default: {
            action: "List Codex chats",
            running: "Listing Codex chats",
            done: "Listed Codex chats",
          },
        },
        codex_session_read: {
          default: {
            action: "Read Codex chat",
            running: "Reading Codex chat",
            done: "Read Codex chat",
          },
        },
        codex_session_send: {
          default: {
            action: "Send to Codex chat",
            running: "Sending to Codex chat",
            done: "Sent to Codex chat",
          },
        },
        codex_session_interrupt: {
          default: {
            action: "Interrupt Codex chat",
            running: "Interrupting Codex chat",
            done: "Interrupted Codex chat",
          },
        },
      },
    },
  },
} satisfies TranslationMap;

export const registerChatToolOperationsEnglish = Object.assign(
  () => Object.assign(en.chat.toolCards, enChatToolOperations.chat.toolCards),
  { catalog: enChatToolOperations },
);
