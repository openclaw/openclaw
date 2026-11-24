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
      operationLabels: {
        message: {
          send: { action: "Send message", running: "Sending message", done: "Send message" },
          broadcast: {
            action: "Broadcast message",
            running: "Broadcasting message",
            done: "Broadcast message",
          },
          poll: { action: "Create poll", running: "Creating poll", done: "Created poll" },
          "poll-vote": { action: "Vote in poll", running: "Voting in poll", done: "Voted in poll" },
          react: {
            action: "React to message",
            running: "Reacting to message",
            done: "Reacted to message",
            unchanged: "Reaction already present",
          },
          remove_reaction: {
            action: "Remove reaction",
            running: "Removing reaction",
            done: "Removed reaction",
            unchanged: "No reaction removed",
          },
          clear_reactions: {
            action: "Clear reactions",
            running: "Clearing reactions",
            done: "Cleared reactions",
            unchanged: "No reactions cleared",
          },
          reactions: {
            action: "Read reactions",
            running: "Reading reactions",
            done: "Read reactions",
          },
          read: { action: "Read messages", running: "Reading messages", done: "Read messages" },
          edit: { action: "Edit message", running: "Editing message", done: "Edited message" },
          unsend: {
            action: "Unsend message",
            running: "Unsending message",
            done: "Unsent message",
          },
          reply: {
            action: "Reply to message",
            running: "Replying to message",
            done: "Replied to message",
          },
          sendWithEffect: {
            action: "Send message with effect",
            running: "Sending message with effect",
            done: "Send message with effect",
          },
          renameGroup: { action: "Rename group", running: "Renaming group", done: "Renamed group" },
          setGroupIcon: {
            action: "Set group icon",
            running: "Setting group icon",
            done: "Set group icon",
          },
          addParticipant: {
            action: "Add participant",
            running: "Adding participant",
            done: "Added participant",
          },
          removeParticipant: {
            action: "Remove participant",
            running: "Removing participant",
            done: "Removed participant",
          },
          leaveGroup: { action: "Leave group", running: "Leaving group", done: "Left group" },
          sendAttachment: {
            action: "Send attachment",
            running: "Sending attachment",
            done: "Sent attachment",
          },
          delete: {
            action: "Delete message",
            running: "Deleting message",
            done: "Deleted message",
          },
          pin: { action: "Pin message", running: "Pinning message", done: "Pinned message" },
          unpin: {
            action: "Unpin message",
            running: "Unpinning message",
            done: "Unpinned message",
          },
          "list-pins": {
            action: "List pinned messages",
            running: "Listing pinned messages",
            done: "Listed pinned messages",
          },
          permissions: {
            action: "Read conversation permissions",
            running: "Reading conversation permissions",
            done: "Read conversation permissions",
          },
          "thread-create": {
            action: "Create thread",
            running: "Creating thread",
            done: "Created thread",
          },
          "thread-list": {
            action: "List threads",
            running: "Listing threads",
            done: "Listed threads",
          },
          "thread-reply": {
            action: "Reply to thread",
            running: "Replying to thread",
            done: "Replied to thread",
          },
          search: {
            action: "Search messages",
            running: "Searching messages",
            done: "Searched messages",
          },
          sticker: { action: "Send sticker", running: "Sending sticker", done: "Sent sticker" },
          "sticker-search": {
            action: "Search stickers",
            running: "Searching stickers",
            done: "Searched stickers",
          },
          "member-info": {
            action: "Read member information",
            running: "Reading member information",
            done: "Read member information",
          },
          "role-info": {
            action: "Read role information",
            running: "Reading role information",
            done: "Read role information",
          },
          "emoji-list": { action: "List emoji", running: "Listing emoji", done: "Listed emoji" },
          "emoji-upload": {
            action: "Upload emoji",
            running: "Uploading emoji",
            done: "Uploaded emoji",
          },
          "sticker-upload": {
            action: "Upload sticker",
            running: "Uploading sticker",
            done: "Uploaded sticker",
          },
          "role-add": { action: "Add role", running: "Adding role", done: "Added role" },
          "role-remove": { action: "Remove role", running: "Removing role", done: "Removed role" },
          "channel-info": {
            action: "Read channel information",
            running: "Reading channel information",
            done: "Read channel information",
          },
          "channel-list": {
            action: "List channels",
            running: "Listing channels",
            done: "Listed channels",
          },
          "channel-create": {
            action: "Create channel",
            running: "Creating channel",
            done: "Created channel",
          },
          "conversation-open": {
            action: "Open conversation",
            running: "Opening conversation",
            done: "Opened conversation",
          },
          "channel-edit": {
            action: "Edit channel",
            running: "Editing channel",
            done: "Edited channel",
          },
          "channel-delete": {
            action: "Delete channel",
            running: "Deleting channel",
            done: "Deleted channel",
          },
          "channel-move": {
            action: "Move channel",
            running: "Moving channel",
            done: "Moved channel",
          },
          "category-create": {
            action: "Create category",
            running: "Creating category",
            done: "Created category",
          },
          "category-edit": {
            action: "Edit category",
            running: "Editing category",
            done: "Edited category",
          },
          "category-delete": {
            action: "Delete category",
            running: "Deleting category",
            done: "Deleted category",
          },
          "topic-create": {
            action: "Create topic",
            running: "Creating topic",
            done: "Created topic",
          },
          "topic-edit": { action: "Edit topic", running: "Editing topic", done: "Edited topic" },
          "voice-status": {
            action: "Check voice status",
            running: "Checking voice status",
            done: "Checked voice status",
          },
          "event-list": { action: "List events", running: "Listing events", done: "Listed events" },
          "event-create": {
            action: "Create event",
            running: "Creating event",
            done: "Created event",
          },
          timeout: {
            action: "Time out member",
            running: "Timing out member",
            done: "Timed out member",
          },
          kick: { action: "Remove member", running: "Removing member", done: "Removed member" },
          ban: { action: "Ban member", running: "Banning member", done: "Banned member" },
          "set-profile": { action: "Set profile", running: "Setting profile", done: "Set profile" },
          "set-presence": {
            action: "Set presence",
            running: "Setting presence",
            done: "Set presence",
          },
          "download-file": {
            action: "Download message file",
            running: "Downloading message file",
            done: "Downloaded message file",
          },
          "upload-file": {
            action: "Upload message file",
            running: "Uploading message file",
            done: "Uploaded message file",
          },
        },
        discussion: {
          default: {
            action: "Discuss question",
            running: "Discussing question",
            done: "Discussed question",
          },
        },
        facetime_call: {
          get_status: {
            action: "Check FaceTime call",
            running: "Checking FaceTime call",
            done: "Checked FaceTime call",
          },
          check_readiness: {
            action: "Check FaceTime setup",
            running: "Checking FaceTime setup",
            done: "Checked FaceTime setup",
          },
          initiate_call: {
            action: "Request FaceTime call",
            running: "Requesting FaceTime call",
            done: "Requested FaceTime call",
          },
          end_call: {
            action: "End FaceTime call",
            running: "Ending FaceTime call",
            done: "Ended FaceTime call",
          },
        },
        feishu_app_scopes: {
          default: {
            action: "Read Feishu app permissions",
            running: "Reading Feishu app permissions",
            done: "Read Feishu app permissions",
          },
        },
        feishu_bitable_create_app: {
          default: {
            action: "Create Feishu table app",
            running: "Creating Feishu table app",
            done: "Created Feishu table app",
          },
        },
        feishu_bitable_create_field: {
          default: {
            action: "Create Feishu table field",
            running: "Creating Feishu table field",
            done: "Created Feishu table field",
          },
        },
        feishu_bitable_create_record: {
          default: {
            action: "Create Feishu table record",
            running: "Creating Feishu table record",
            done: "Created Feishu table record",
          },
        },
        feishu_bitable_get_meta: {
          default: {
            action: "Read Feishu table metadata",
            running: "Reading Feishu table metadata",
            done: "Read Feishu table metadata",
          },
        },
        feishu_bitable_get_record: {
          default: {
            action: "Read Feishu table record",
            running: "Reading Feishu table record",
            done: "Read Feishu table record",
          },
        },
        feishu_bitable_list_fields: {
          default: {
            action: "List Feishu table fields",
            running: "Listing Feishu table fields",
            done: "Listed Feishu table fields",
          },
        },
        feishu_bitable_list_records: {
          default: {
            action: "List Feishu table records",
            running: "Listing Feishu table records",
            done: "Listed Feishu table records",
          },
        },
        feishu_bitable_update_record: {
          default: {
            action: "Update Feishu table record",
            running: "Updating Feishu table record",
            done: "Updated Feishu table record",
          },
        },
        feishu_chat: {
          members: {
            action: "List Feishu chat members",
            running: "Listing Feishu chat members",
            done: "Listed Feishu chat members",
          },
          info: {
            action: "Read Feishu chat",
            running: "Reading Feishu chat",
            done: "Read Feishu chat",
          },
          member_info: {
            action: "Read Feishu member",
            running: "Reading Feishu member",
            done: "Read Feishu member",
          },
        },
        feishu_doc: {
          read: {
            action: "Read Feishu document",
            running: "Reading Feishu document",
            done: "Read Feishu document",
          },
          write: {
            action: "Write Feishu document",
            running: "Writing Feishu document",
            done: "Wrote Feishu document",
          },
          append: {
            action: "Append to Feishu document",
            running: "Appending to Feishu document",
            done: "Appended to Feishu document",
          },
          insert: {
            action: "Insert into Feishu document",
            running: "Inserting into Feishu document",
            done: "Inserted into Feishu document",
          },
          create: {
            action: "Create Feishu document",
            running: "Creating Feishu document",
            done: "Created Feishu document",
          },
          list_blocks: {
            action: "List document blocks",
            running: "Listing document blocks",
            done: "Listed document blocks",
          },
          get_block: {
            action: "Read document block",
            running: "Reading document block",
            done: "Read document block",
          },
          update_block: {
            action: "Update document block",
            running: "Updating document block",
            done: "Updated document block",
          },
          delete_block: {
            action: "Delete document block",
            running: "Deleting document block",
            done: "Deleted document block",
          },
          create_table: {
            action: "Create document table",
            running: "Creating document table",
            done: "Created document table",
          },
          write_table_cells: {
            action: "Write table cells",
            running: "Writing table cells",
            done: "Wrote table cells",
          },
          create_table_with_values: {
            action: "Create populated document table",
            running: "Creating populated document table",
            done: "Created populated document table",
          },
          insert_table_row: {
            action: "Insert table row",
            running: "Inserting table row",
            done: "Inserted table row",
          },
          insert_table_column: {
            action: "Insert table column",
            running: "Inserting table column",
            done: "Inserted table column",
          },
          delete_table_rows: {
            action: "Delete table rows",
            running: "Deleting table rows",
            done: "Deleted table rows",
          },
          delete_table_columns: {
            action: "Delete table columns",
            running: "Deleting table columns",
            done: "Deleted table columns",
          },
          merge_table_cells: {
            action: "Merge table cells",
            running: "Merging table cells",
            done: "Merged table cells",
          },
          upload_image: {
            action: "Upload document image",
            running: "Uploading document image",
            done: "Uploaded document image",
          },
          upload_file: {
            action: "Upload document file",
            running: "Uploading document file",
            done: "Uploaded document file",
          },
          color_text: {
            action: "Set text color",
            running: "Setting text color",
            done: "Set text color",
          },
        },
        feishu_drive: {
          list: {
            action: "List Feishu files",
            running: "Listing Feishu files",
            done: "Listed Feishu files",
          },
          info: {
            action: "Read Feishu file information",
            running: "Reading Feishu file information",
            done: "Read Feishu file information",
          },
          create_folder: {
            action: "Create Feishu folder",
            running: "Creating Feishu folder",
            done: "Created Feishu folder",
          },
          move: {
            action: "Move Feishu file",
            running: "Moving Feishu file",
            done: "Moved Feishu file",
          },
          delete: {
            action: "Delete Feishu file",
            running: "Deleting Feishu file",
            done: "Deleted Feishu file",
          },
          list_comments: {
            action: "List file comments",
            running: "Listing file comments",
            done: "Listed file comments",
          },
          list_comment_replies: {
            action: "List comment replies",
            running: "Listing comment replies",
            done: "Listed comment replies",
          },
          add_comment: {
            action: "Comment on Feishu file",
            running: "Commenting on Feishu file",
            done: "Commented on Feishu file",
          },
          reply_comment: {
            action: "Reply to file comment",
            running: "Replying to file comment",
            done: "Replied to file comment",
          },
        },
        feishu_perm: {
          list: {
            action: "List Feishu permissions",
            running: "Listing Feishu permissions",
            done: "Listed Feishu permissions",
          },
          add: {
            action: "Add Feishu permission",
            running: "Adding Feishu permission",
            done: "Added Feishu permission",
          },
          remove: {
            action: "Remove Feishu permission",
            running: "Removing Feishu permission",
            done: "Removed Feishu permission",
          },
        },
        feishu_wiki: {
          spaces: {
            action: "List Feishu wiki spaces",
            running: "Listing Feishu wiki spaces",
            done: "Listed Feishu wiki spaces",
          },
          nodes: {
            action: "List Feishu wiki pages",
            running: "Listing Feishu wiki pages",
            done: "Listed Feishu wiki pages",
          },
          get: {
            action: "Read Feishu wiki page",
            running: "Reading Feishu wiki page",
            done: "Read Feishu wiki page",
          },
          search: {
            action: "Search Feishu wiki",
            running: "Searching Feishu wiki",
            done: "Searched Feishu wiki",
          },
          create: {
            action: "Create Feishu wiki page",
            running: "Creating Feishu wiki page",
            done: "Created Feishu wiki page",
          },
          move: {
            action: "Move Feishu wiki page",
            running: "Moving Feishu wiki page",
            done: "Moved Feishu wiki page",
          },
          rename: {
            action: "Rename Feishu wiki page",
            running: "Renaming Feishu wiki page",
            done: "Renamed Feishu wiki page",
          },
        },
        google_meet: {
          join: {
            action: "Join Google Meet",
            running: "Joining Google Meet",
            done: "Joined Google Meet",
          },
          create: {
            action: "Create Google Meet",
            running: "Creating Google Meet",
            done: "Created Google Meet",
          },
          status: {
            action: "Check Google Meet",
            running: "Checking Google Meet",
            done: "Checked Google Meet",
          },
          transcript: {
            action: "Read meeting transcript",
            running: "Reading meeting transcript",
            done: "Read meeting transcript",
          },
          participation_context: {
            action: "Read meeting participation context",
            running: "Reading meeting participation context",
            done: "Read meeting participation context",
          },
          participate: {
            action: "Participate in meeting",
            running: "Participating in meeting",
            done: "Participated in meeting",
          },
          setup_status: {
            action: "Check meeting setup",
            running: "Checking meeting setup",
            done: "Checked meeting setup",
          },
          resolve_space: {
            action: "Resolve meeting space",
            running: "Resolving meeting space",
            done: "Resolved meeting space",
          },
          preflight: {
            action: "Check meeting readiness",
            running: "Checking meeting readiness",
            done: "Checked meeting readiness",
          },
          latest: {
            action: "Read latest meeting",
            running: "Reading latest meeting",
            done: "Read latest meeting",
          },
          calendar_events: {
            action: "List calendar meetings",
            running: "Listing calendar meetings",
            done: "Listed calendar meetings",
          },
          artifacts: {
            action: "List meeting artifacts",
            running: "Listing meeting artifacts",
            done: "Listed meeting artifacts",
          },
          attendance: {
            action: "Read meeting attendance",
            running: "Reading meeting attendance",
            done: "Read meeting attendance",
          },
          export: {
            action: "Export meeting",
            running: "Exporting meeting",
            done: "Exported meeting",
          },
          recover_current_tab: {
            action: "Recover meeting tab",
            running: "Recovering meeting tab",
            done: "Recovered meeting tab",
          },
          leave: {
            action: "Leave Google Meet",
            running: "Leaving Google Meet",
            done: "Left Google Meet",
          },
          end_active_conference: {
            action: "End active conference",
            running: "Ending active conference",
            done: "Ended active conference",
          },
          speak: {
            action: "Speak in meeting",
            running: "Speaking in meeting",
            done: "Spoke in meeting",
          },
          test_speech: {
            action: "Check meeting speech",
            running: "Checking meeting speech",
            done: "Checked meeting speech",
          },
          test_listen: {
            action: "Check meeting audio",
            running: "Checking meeting audio",
            done: "Checked meeting audio",
          },
        },
        slack_huddles: {
          join: {
            action: "Join Slack huddle",
            running: "Joining Slack huddle",
            done: "Joined Slack huddle",
          },
          leave: {
            action: "Leave Slack huddle",
            running: "Leaving Slack huddle",
            done: "Left Slack huddle",
          },
          status: {
            action: "Check Slack huddle",
            running: "Checking Slack huddle",
            done: "Checked Slack huddle",
          },
          transcript: {
            action: "Read Slack huddle transcript",
            running: "Reading Slack huddle transcript",
            done: "Read Slack huddle transcript",
          },
          speak: {
            action: "Speak in Slack huddle",
            running: "Speaking in Slack huddle",
            done: "Spoke in Slack huddle",
          },
        },
        talk_voice: {
          list: { action: "List voices", running: "Listing voices", done: "Listed voices" },
          set: { action: "Set voice", running: "Setting voice", done: "Set voice" },
        },
        teams_meetings: {
          join: {
            action: "Join Teams meeting",
            running: "Joining Teams meeting",
            done: "Joined Teams meeting",
          },
          leave: {
            action: "Leave Teams meeting",
            running: "Leaving Teams meeting",
            done: "Left Teams meeting",
          },
          status: {
            action: "Check Teams meeting",
            running: "Checking Teams meeting",
            done: "Checked Teams meeting",
          },
          transcript: {
            action: "Read Teams meeting transcript",
            running: "Reading Teams meeting transcript",
            done: "Read Teams meeting transcript",
          },
          speak: {
            action: "Speak in Teams meeting",
            running: "Speaking in Teams meeting",
            done: "Spoke in Teams meeting",
          },
        },
        voice_call: {
          initiate_call: {
            action: "Request voice call",
            running: "Requesting voice call",
            done: "Requested voice call",
          },
          steer_call: {
            action: "Guide voice call",
            running: "Guiding voice call",
            done: "Guided voice call",
          },
          continue_call: {
            action: "Continue voice call",
            running: "Continuing voice call",
            done: "Continued voice call",
          },
          speak_to_user: {
            action: "Speak in call",
            running: "Speaking in call",
            done: "Spoke in call",
          },
          send_dtmf: {
            action: "Send call keypad tones",
            running: "Sending call keypad tones",
            done: "Sent call keypad tones",
          },
          end_call: {
            action: "End voice call",
            running: "Ending voice call",
            done: "Ended voice call",
          },
          get_status: {
            action: "Check voice call",
            running: "Checking voice call",
            done: "Checked voice call",
          },
        },
        whatsapp_call: {
          status: {
            action: "Check WhatsApp call",
            running: "Checking WhatsApp call",
            done: "Checked WhatsApp call",
          },
          call: {
            action: "Request WhatsApp call",
            running: "Requesting WhatsApp call",
            done: "Requested WhatsApp call",
          },
        },
        whatsapp_login: {
          start: {
            action: "Start WhatsApp sign-in",
            running: "Starting WhatsApp sign-in",
            done: "Started WhatsApp sign-in",
          },
          wait: {
            action: "Wait for WhatsApp sign-in",
            running: "Waiting for WhatsApp sign-in",
            done: "Waited for WhatsApp sign-in",
          },
        },
        zalouser: {
          send: {
            action: "Send Zalo message",
            running: "Sending Zalo message",
            done: "Sent Zalo message",
          },
          image: {
            action: "Send Zalo image",
            running: "Sending Zalo image",
            done: "Sent Zalo image",
          },
          link: { action: "Send Zalo link", running: "Sending Zalo link", done: "Sent Zalo link" },
          friends: {
            action: "List Zalo friends",
            running: "Listing Zalo friends",
            done: "Listed Zalo friends",
          },
          groups: {
            action: "List Zalo groups",
            running: "Listing Zalo groups",
            done: "Listed Zalo groups",
          },
          me: {
            action: "Read Zalo profile",
            running: "Reading Zalo profile",
            done: "Read Zalo profile",
          },
          status: {
            action: "Check Zalo connection",
            running: "Checking Zalo connection",
            done: "Checked Zalo connection",
          },
        },
        zoom_meetings: {
          join: {
            action: "Join Zoom meeting",
            running: "Joining Zoom meeting",
            done: "Joined Zoom meeting",
          },
          leave: {
            action: "Leave Zoom meeting",
            running: "Leaving Zoom meeting",
            done: "Left Zoom meeting",
          },
          status: {
            action: "Check Zoom meeting",
            running: "Checking Zoom meeting",
            done: "Checked Zoom meeting",
          },
          transcript: {
            action: "Read Zoom meeting transcript",
            running: "Reading Zoom meeting transcript",
            done: "Read Zoom meeting transcript",
          },
          speak: {
            action: "Speak in Zoom meeting",
            running: "Speaking in Zoom meeting",
            done: "Spoke in Zoom meeting",
          },
        },
        facetime_end_call: {
          default: {
            action: "End FaceTime call",
            running: "Ending FaceTime call",
            done: "Ended FaceTime call",
          },
        },
        openclaw_end_call: {
          default: {
            action: "End voice call",
            running: "Ending voice call",
            done: "Ended voice call",
          },
        },
        web_search: {
          default: {
            action: "Search the web",
            running: "Searching the web",
            done: "Searched the web",
          },
        },
        web_fetch: {
          default: { action: "Read webpage", running: "Reading webpage", done: "Read webpage" },
        },
        x_search: {
          default: { action: "Search X", running: "Searching X", done: "Searched X" },
        },
        browser: {
          doctor: {
            action: "Check browser setup",
            running: "Checking browser setup",
            done: "Checked browser setup",
          },
          status: {
            action: "Check browser status",
            running: "Checking browser status",
            done: "Checked browser status",
          },
          start: { action: "Start browser", running: "Starting browser", done: "Started browser" },
          stop: { action: "Stop browser", running: "Stopping browser", done: "Stopped browser" },
          profiles: {
            action: "List browser profiles",
            running: "Listing browser profiles",
            done: "Listed browser profiles",
          },
          importprofile: {
            action: "Import browser profile",
            running: "Importing browser profile",
            done: "Imported browser profile",
          },
          tabs: {
            action: "List browser tabs",
            running: "Listing browser tabs",
            done: "Listed browser tabs",
          },
          open: {
            action: "Open browser tab",
            running: "Opening browser tab",
            done: "Opened browser tab",
          },
          focus: {
            action: "Focus browser tab",
            running: "Focusing browser tab",
            done: "Focused browser tab",
          },
          close: {
            action: "Close browser tab",
            running: "Closing browser tab",
            done: "Closed browser tab",
          },
          snapshot: {
            action: "Read browser page",
            running: "Reading browser page",
            done: "Read browser page",
          },
          screenshot: {
            action: "Capture browser screenshot",
            running: "Capturing browser screenshot",
            done: "Captured browser screenshot",
          },
          navigate: {
            action: "Navigate browser",
            running: "Navigating browser",
            done: "Navigated browser",
          },
          console: {
            action: "Read browser console",
            running: "Reading browser console",
            done: "Read browser console",
          },
          requests: {
            action: "Read browser requests",
            running: "Reading browser requests",
            done: "Read browser requests",
          },
          errors: {
            action: "Read browser errors",
            running: "Reading browser errors",
            done: "Read browser errors",
          },
          text: { action: "Read page text", running: "Reading page text", done: "Read page text" },
          judge: { action: "Evaluate page", running: "Evaluating page", done: "Evaluated page" },
          emulate: {
            action: "Emulate browser environment",
            running: "Emulating browser environment",
            done: "Emulated browser environment",
          },
          pdf: {
            action: "Save page as PDF",
            running: "Saving page as PDF",
            done: "Saved page as PDF",
          },
          download: {
            action: "Download browser file",
            running: "Downloading browser file",
            done: "Downloaded browser file",
          },
          waitfordownload: {
            action: "Wait for browser download",
            running: "Waiting for browser download",
            done: "Waited for browser download",
          },
          upload: {
            action: "Upload browser file",
            running: "Uploading browser file",
            done: "Uploaded browser file",
          },
          dialog: {
            action: "Handle browser dialog",
            running: "Handling browser dialog",
            done: "Handled browser dialog",
          },
          act: {
            action: "Interact with browser",
            running: "Interacting with browser",
            done: "Interacted with browser",
          },
          act_batch: {
            action: "Run browser actions",
            running: "Running browser actions",
            done: "Ran browser actions",
          },
          act_click: {
            action: "Click browser element",
            running: "Clicking browser element",
            done: "Clicked browser element",
          },
          act_clickCoords: {
            action: "Click browser coordinates",
            running: "Clicking browser coordinates",
            done: "Clicked browser coordinates",
          },
          act_type: {
            action: "Type in browser",
            running: "Typing in browser",
            done: "Typed in browser",
          },
          act_press: {
            action: "Press browser key",
            running: "Pressing browser key",
            done: "Pressed browser key",
          },
          act_hover: {
            action: "Hover over browser element",
            running: "Hovering over browser element",
            done: "Hovered over browser element",
          },
          act_scrollIntoView: {
            action: "Scroll browser element into view",
            running: "Scrolling browser element into view",
            done: "Scrolled browser element into view",
          },
          act_drag: {
            action: "Drag browser element",
            running: "Dragging browser element",
            done: "Dragged browser element",
          },
          act_select: {
            action: "Select browser option",
            running: "Selecting browser option",
            done: "Selected browser option",
          },
          act_fill: {
            action: "Fill browser fields",
            running: "Filling browser fields",
            done: "Filled browser fields",
          },
          act_resize: {
            action: "Resize browser viewport",
            running: "Resizing browser viewport",
            done: "Resized browser viewport",
          },
          act_wait: {
            action: "Wait for browser condition",
            running: "Waiting for browser condition",
            done: "Waited for browser condition",
          },
          act_evaluate: {
            action: "Run browser JavaScript",
            running: "Running browser JavaScript",
            done: "Ran browser JavaScript",
          },
          act_close: {
            action: "Close browser tab",
            running: "Closing browser tab",
            done: "Closed browser tab",
          },
        },
        screen: {
          default: { action: "Read screen", running: "Reading screen", done: "Read screen" },
          split_right: {
            action: "Split pane to the right",
            running: "Splitting pane to the right",
            done: "Split pane to the right",
          },
          split_down: {
            action: "Split pane below",
            running: "Splitting pane below",
            done: "Split pane below",
          },
          close_pane: { action: "Close pane", running: "Closing pane", done: "Closed pane" },
          focus: { action: "Focus pane", running: "Focusing pane", done: "Focused pane" },
          sidebar_show: {
            action: "Show sidebar",
            running: "Showing sidebar",
            done: "Showed sidebar",
          },
          sidebar_hide: { action: "Hide sidebar", running: "Hiding sidebar", done: "Hid sidebar" },
          terminal_show: {
            action: "Show terminal",
            running: "Showing terminal",
            done: "Showed terminal",
          },
          terminal_hide: {
            action: "Hide terminal",
            running: "Hiding terminal",
            done: "Hid terminal",
          },
          browser_show: {
            action: "Show browser",
            running: "Showing browser",
            done: "Showed browser",
          },
          browser_hide: { action: "Hide browser", running: "Hiding browser", done: "Hid browser" },
          desktop_show: {
            action: "Show desktop",
            running: "Showing desktop",
            done: "Showed desktop",
          },
          desktop_hide: { action: "Hide desktop", running: "Hiding desktop", done: "Hid desktop" },
          portal_show: { action: "Show portal", running: "Showing portal", done: "Showed portal" },
          portal_hide: { action: "Hide portal", running: "Hiding portal", done: "Hid portal" },
          navigate: {
            action: "Navigate OpenClaw",
            running: "Navigating OpenClaw",
            done: "Navigated OpenClaw",
          },
          template_review: {
            action: "Show template review",
            running: "Showing template review",
            done: "Showed template review",
          },
          github_identity_settings: {
            action: "Open GitHub identity settings",
            running: "Opening GitHub identity settings",
            done: "Opened GitHub identity settings",
          },
        },
        theme: {
          list: { action: "List themes", running: "Listing themes", done: "Listed themes" },
          get: { action: "Read theme", running: "Reading theme", done: "Read theme" },
          set: { action: "Set theme", running: "Setting theme", done: "Set theme" },
          import: { action: "Import theme", running: "Importing theme", done: "Imported theme" },
        },
        dashboard: {
          read: { action: "Read dashboard", running: "Reading dashboard", done: "Read dashboard" },
          tab_create: {
            action: "Create dashboard tab",
            running: "Creating dashboard tab",
            done: "Created dashboard tab",
          },
          tab_update: {
            action: "Update dashboard tab",
            running: "Updating dashboard tab",
            done: "Updated dashboard tab",
          },
          tab_delete: {
            action: "Delete dashboard tab",
            running: "Deleting dashboard tab",
            done: "Deleted dashboard tab",
          },
          tabs_reorder: {
            action: "Reorder dashboard tabs",
            running: "Reordering dashboard tabs",
            done: "Reordered dashboard tabs",
          },
          widget_put: {
            action: "Set dashboard widget",
            running: "Setting dashboard widget",
            done: "Set dashboard widget",
          },
          widget_move: {
            action: "Move dashboard widget",
            running: "Moving dashboard widget",
            done: "Moved dashboard widget",
          },
          widget_resize: {
            action: "Resize dashboard widget",
            running: "Resizing dashboard widget",
            done: "Resized dashboard widget",
          },
          widget_remove: {
            action: "Remove dashboard widget",
            running: "Removing dashboard widget",
            done: "Removed dashboard widget",
          },
          focus_tab: {
            action: "Focus dashboard tab",
            running: "Focusing dashboard tab",
            done: "Focused dashboard tab",
          },
          set_presentation: {
            action: "Set dashboard layout",
            running: "Setting dashboard layout",
            done: "Set dashboard layout",
          },
          set_default_presentation: {
            action: "Set default dashboard layout",
            running: "Setting default dashboard layout",
            done: "Set default dashboard layout",
          },
        },
        terminal: {
          read: { action: "Read terminal", running: "Reading terminal", done: "Read terminal" },
          list: {
            action: "List terminals",
            running: "Listing terminals",
            done: "Listed terminals",
          },
          resize: {
            action: "Resize terminal",
            running: "Resizing terminal",
            done: "Resized terminal",
          },
          close: { action: "Close terminal", running: "Closing terminal", done: "Closed terminal" },
          input: {
            action: "Send terminal input",
            running: "Sending terminal input",
            done: "Sent terminal input",
          },
        },
        portal: {
          open: { action: "Open portal", running: "Opening portal", done: "Opened portal" },
          list: { action: "List portals", running: "Listing portals", done: "Listed portals" },
          close: { action: "Close portal", running: "Closing portal", done: "Closed portal" },
        },
        canvas: {
          present: { action: "Show canvas", running: "Showing canvas", done: "Showed canvas" },
          hide: { action: "Hide canvas", running: "Hiding canvas", done: "Hid canvas" },
          navigate: {
            action: "Navigate canvas",
            running: "Navigating canvas",
            done: "Navigated canvas",
          },
        },
        show_widget: {
          default: { action: "Show widget", running: "Showing widget", done: "Showed widget" },
        },
        nodes: {
          status: { action: "Check nodes", running: "Checking nodes", done: "Checked nodes" },
          describe: { action: "Describe node", running: "Describing node", done: "Described node" },
          pending: {
            action: "List node requests",
            running: "Listing node requests",
            done: "Listed node requests",
          },
          approve: {
            action: "Approve node request",
            running: "Approving node request",
            done: "Approved node request",
          },
          reject: {
            action: "Reject node request",
            running: "Rejecting node request",
            done: "Rejected node request",
          },
          notify: {
            action: "Send node notification",
            running: "Sending node notification",
            done: "Sent node notification",
          },
          camera_snap: {
            action: "Capture camera photo",
            running: "Capturing camera photo",
            done: "Captured camera photo",
          },
          camera_list: {
            action: "List cameras",
            running: "Listing cameras",
            done: "Listed cameras",
          },
          camera_clip: {
            action: "Record camera clip",
            running: "Recording camera clip",
            done: "Recorded camera clip",
          },
          camera_ptz: { action: "Move camera", running: "Moving camera", done: "Moved camera" },
          photos_latest: {
            action: "Read latest photos",
            running: "Reading latest photos",
            done: "Read latest photos",
          },
          screen_record: {
            action: "Record node screen",
            running: "Recording node screen",
            done: "Recorded node screen",
          },
          screen_snapshot: {
            action: "Capture node screen",
            running: "Capturing node screen",
            done: "Captured node screen",
          },
          location_get: {
            action: "Read node location",
            running: "Reading node location",
            done: "Read node location",
          },
          notifications_list: {
            action: "List node notifications",
            running: "Listing node notifications",
            done: "Listed node notifications",
          },
          notifications_action: {
            action: "Act on node notification",
            running: "Acting on node notification",
            done: "Acted on node notification",
          },
          device_status: {
            action: "Check device status",
            running: "Checking device status",
            done: "Checked device status",
          },
          device_info: {
            action: "Read device information",
            running: "Reading device information",
            done: "Read device information",
          },
          device_permissions: {
            action: "Read device permissions",
            running: "Reading device permissions",
            done: "Read device permissions",
          },
          device_health: {
            action: "Check device health",
            running: "Checking device health",
            done: "Checked device health",
          },
          which: {
            action: "Locate node executable",
            running: "Locating node executable",
            done: "Located node executable",
          },
          invoke: {
            action: "Invoke node command",
            running: "Invoking node command",
            done: "Invoked node command",
          },
        },
        computer: {
          screenshot: {
            action: "Capture screen",
            running: "Capturing screen",
            done: "Captured screen",
          },
          left_click: { action: "Click", running: "Clicking", done: "Clicked" },
          right_click: { action: "Right-click", running: "Right-clicking", done: "Right-clicked" },
          middle_click: {
            action: "Middle-click",
            running: "Middle-clicking",
            done: "Middle-clicked",
          },
          double_click: {
            action: "Double-click",
            running: "Double-clicking",
            done: "Double-clicked",
          },
          triple_click: {
            action: "Triple-click",
            running: "Triple-clicking",
            done: "Triple-clicked",
          },
          mouse_move: { action: "Move pointer", running: "Moving pointer", done: "Moved pointer" },
          left_click_drag: { action: "Drag", running: "Dragging", done: "Dragged" },
          left_mouse_down: {
            action: "Press mouse button",
            running: "Pressing mouse button",
            done: "Pressed mouse button",
          },
          left_mouse_up: {
            action: "Release mouse button",
            running: "Releasing mouse button",
            done: "Released mouse button",
          },
          scroll: { action: "Scroll", running: "Scrolling", done: "Scrolled" },
          type: { action: "Type text", running: "Typing text", done: "Typed text" },
          key: { action: "Press key", running: "Pressing key", done: "Pressed key" },
          hold_key: { action: "Hold key", running: "Holding key", done: "Held key" },
          wait: { action: "Wait", running: "Waiting", done: "Waited" },
          list_apps: { action: "List apps", running: "Listing apps", done: "Listed apps" },
          list_windows: {
            action: "List windows",
            running: "Listing windows",
            done: "Listed windows",
          },
          get_accessibility_tree: {
            action: "Read accessibility tree",
            running: "Reading accessibility tree",
            done: "Read accessibility tree",
          },
          get_cursor_position: {
            action: "Read pointer position",
            running: "Reading pointer position",
            done: "Read pointer position",
          },
          get_window_state: {
            action: "Read window",
            running: "Reading window",
            done: "Read window",
          },
          launch_app: { action: "Launch app", running: "Launching app", done: "Launched app" },
          kill_app: { action: "Stop app", running: "Stopping app", done: "Stopped app" },
          bring_to_front: {
            action: "Focus window",
            running: "Focusing window",
            done: "Focused window",
          },
          set_value: {
            action: "Set field value",
            running: "Setting field value",
            done: "Set field value",
          },
          zoom: { action: "Zoom", running: "Zooming", done: "Zoomed" },
          get_browser_state: {
            action: "Read browser state",
            running: "Reading browser state",
            done: "Read browser state",
          },
          browser_prepare: {
            action: "Prepare browser",
            running: "Preparing browser",
            done: "Prepared browser",
          },
          browser_navigate: {
            action: "Navigate browser",
            running: "Navigating browser",
            done: "Navigated browser",
          },
          browser_click: {
            action: "Click browser element",
            running: "Clicking browser element",
            done: "Clicked browser element",
          },
          browser_type: {
            action: "Type in browser",
            running: "Typing in browser",
            done: "Typed in browser",
          },
          browser_dialog: {
            action: "Handle browser dialog",
            running: "Handling browser dialog",
            done: "Handled browser dialog",
          },
          browser_set_input_files: {
            action: "Select browser upload files",
            running: "Selecting browser upload files",
            done: "Selected browser upload files",
          },
          browser_download: {
            action: "Download browser file",
            running: "Downloading browser file",
            done: "Downloaded browser file",
          },
          browser_pointer: {
            action: "Move browser pointer",
            running: "Moving browser pointer",
            done: "Moved browser pointer",
          },
          escalate_scope: {
            action: "Request broader computer access",
            running: "Requesting broader computer access",
            done: "Requested broader computer access",
          },
          get_recording_state: {
            action: "Check screen recording",
            running: "Checking screen recording",
            done: "Checked screen recording",
          },
          start_recording: {
            action: "Start screen recording",
            running: "Starting screen recording",
            done: "Started screen recording",
          },
          stop_recording: {
            action: "Stop screen recording",
            running: "Stopping screen recording",
            done: "Stopped screen recording",
          },
          replay_trajectory: {
            action: "Replay computer actions",
            running: "Replaying computer actions",
            done: "Replayed computer actions",
          },
          invoke_menu: {
            action: "Select menu item",
            running: "Selecting menu item",
            done: "Selected menu item",
          },
          take_control: {
            action: "Request computer control",
            running: "Requesting computer control",
            done: "Requested computer control",
          },
        },
        mobile_ui: {
          observe: {
            action: "Read mobile screen",
            running: "Reading mobile screen",
            done: "Read mobile screen",
          },
          act: {
            action: "Interact with mobile app",
            running: "Interacting with mobile app",
            done: "Interacted with mobile app",
          },
        },
        deep_research: {
          start: {
            action: "Start research",
            running: "Starting research",
            done: "Started research",
          },
          status: {
            action: "Check research",
            running: "Checking research",
            done: "Checked research",
          },
          result: {
            action: "Read research result",
            running: "Reading research result",
            done: "Read research result",
          },
          resume: {
            action: "Resume research",
            running: "Resuming research",
            done: "Resumed research",
          },
          cancel: {
            action: "Cancel research",
            running: "Canceling research",
            done: "Canceled research",
          },
          capabilities: {
            action: "Read research capabilities",
            running: "Reading research capabilities",
            done: "Read research capabilities",
          },
        },
        firecrawl_search: {
          default: {
            action: "Search the web with Firecrawl",
            running: "Searching the web with Firecrawl",
            done: "Searched the web with Firecrawl",
          },
        },
        firecrawl_scrape: {
          default: {
            action: "Read webpage with Firecrawl",
            running: "Reading webpage with Firecrawl",
            done: "Read webpage with Firecrawl",
          },
        },
        tavily_search: {
          default: {
            action: "Search the web with Tavily",
            running: "Searching the web with Tavily",
            done: "Searched the web with Tavily",
          },
        },
        tavily_extract: {
          default: {
            action: "Read webpage with Tavily",
            running: "Reading webpage with Tavily",
            done: "Read webpage with Tavily",
          },
        },
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
          kill: { action: "Stop process", running: "Stopping process", done: "Stopped process" },
          clear: {
            action: "Clear process output",
            running: "Clearing process output",
            done: "Cleared process output",
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
            done: "Sent to conversation",
          },
        },
        conversations_turn: {
          default: {
            action: "Read conversation turn",
            running: "Reading conversation turn",
            done: "Read conversation turn",
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
