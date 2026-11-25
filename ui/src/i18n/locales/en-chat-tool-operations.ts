import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatToolOperations = {
  chat: {
    toolCards: {
      noResultRecorded: "No result recorded",
      operationUnknown: "{action} · outcome unknown",
      operationPendingPublication: "{action} · pending publication",
      operationNotApplied: "{action} · not applied",
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
        memory_search: {
          default: {
            action: "Search memory",
            running: "Searching memory",
            done: "Searched memory",
          },
        },
        memory_get: {
          default: { action: "Read memory", running: "Reading memory", done: "Read memory" },
        },
        personal_instructions: {
          get: {
            action: "Read personal instructions",
            running: "Reading personal instructions",
            done: "Read personal instructions",
          },
          set: {
            action: "Update personal instructions",
            running: "Updating personal instructions",
            done: "Updated personal instructions",
          },
        },
        knowledge_annotate: {
          default: {
            action: "Annotate knowledge context",
            running: "Annotating knowledge context",
            done: "Annotated knowledge context",
          },
        },
        knowledge_attach: {
          default: {
            action: "Upload knowledge source data",
            running: "Uploading knowledge source data",
            done: "Uploaded knowledge source data",
          },
          final: {
            action: "Finish uploading knowledge source file",
            running: "Finishing knowledge source file upload",
            done: "Finished uploading knowledge source file",
          },
        },
        knowledge_attach_file: {
          default: {
            action: "Attach workspace source file",
            running: "Attaching workspace source file",
            done: "Attached workspace source file",
          },
        },
        knowledge_attachment: {
          default: {
            action: "Read knowledge source file",
            running: "Reading knowledge source file",
            done: "Read knowledge source file",
          },
        },
        knowledge_chronicle_day: {
          default: {
            action: "Read knowledge for a day",
            running: "Reading knowledge for a day",
            done: "Read knowledge for a day",
          },
        },
        knowledge_chronicle_last_seen: {
          default: {
            action: "Read latest dated context",
            running: "Reading latest dated context",
            done: "Read latest dated context",
          },
        },
        knowledge_chronicle_since: {
          default: {
            action: "Read recent knowledge",
            running: "Reading recent knowledge",
            done: "Read recent knowledge",
          },
        },
        knowledge_connections: {
          default: {
            action: "Inspect knowledge connections",
            running: "Inspecting knowledge connections",
            done: "Inspected knowledge connections",
          },
        },
        knowledge_correct: {
          default: {
            action: "Correct knowledge",
            running: "Correcting knowledge",
            done: "Corrected knowledge",
          },
        },
        knowledge_create_claim: {
          default: {
            action: "Create knowledge claim",
            running: "Creating knowledge claim",
            done: "Created knowledge claim",
          },
        },
        knowledge_create_relationship: {
          default: {
            action: "Create knowledge relationship",
            running: "Creating knowledge relationship",
            done: "Created knowledge relationship",
          },
        },
        knowledge_diagnostics: {
          default: {
            action: "Check knowledge vault",
            running: "Checking knowledge vault",
            done: "Checked knowledge vault",
          },
        },
        knowledge_edit_body: {
          default: {
            action: "Edit knowledge body",
            running: "Editing knowledge body",
            done: "Edited knowledge body",
          },
        },
        knowledge_evidence_read: {
          default: {
            action: "Read source passage",
            running: "Reading source passage",
            done: "Read source passage",
          },
        },
        knowledge_extract_section: {
          default: {
            action: "Extract knowledge section",
            running: "Extracting knowledge section",
            done: "Extracted knowledge section",
          },
        },
        knowledge_grep: {
          default: {
            action: "Search knowledge",
            running: "Searching knowledge",
            done: "Searched knowledge",
          },
        },
        knowledge_history: {
          default: {
            action: "Read knowledge history",
            running: "Reading knowledge history",
            done: "Read knowledge history",
          },
        },
        knowledge_lookup: {
          default: {
            action: "Resolve knowledge identity",
            running: "Resolving knowledge identity",
            done: "Resolved knowledge identity",
          },
        },
        knowledge_merge: {
          default: {
            action: "Merge duplicate pages",
            running: "Merging duplicate pages",
            done: "Merged duplicate pages",
          },
        },
        knowledge_mutation: {
          default: {
            action: "Inspect knowledge publication",
            running: "Inspecting knowledge publication",
            done: "Inspected knowledge publication",
          },
        },
        knowledge_ontology: {
          default: {
            action: "Inspect ontology",
            running: "Inspecting ontology",
            done: "Inspected ontology",
          },
        },
        knowledge_publish_batch: {
          default: {
            action: "Publish knowledge batch",
            running: "Publishing knowledge batch",
            done: "Published knowledge batch",
          },
        },
        knowledge_recall: {
          default: {
            action: "Curate automatic recall",
            running: "Curating automatic recall",
            done: "Curated automatic recall",
          },
        },
        knowledge_reconcile_evidence: {
          default: {
            action: "Reconcile knowledge evidence",
            running: "Reconciling knowledge evidence",
            done: "Reconciled knowledge evidence",
          },
          preview: {
            action: "Preview knowledge evidence changes",
            running: "Previewing knowledge evidence changes",
            done: "Previewed knowledge evidence changes",
          },
        },
        knowledge_record: {
          default: {
            action: "Inspect knowledge",
            running: "Inspecting knowledge",
            done: "Inspected knowledge",
          },
        },
        knowledge_records: {
          default: {
            action: "Browse knowledge",
            running: "Browsing knowledge",
            done: "Browsed knowledge",
          },
        },
        knowledge_relink: {
          default: {
            action: "Relink remembered claims",
            running: "Relinking remembered claims",
            done: "Checked remembered claims for missing links",
            linked: "Relinked remembered claims",
          },
          preview: {
            action: "Preview links for remembered claims",
            running: "Previewing links for remembered claims",
            done: "Previewed links for remembered claims",
          },
        },
        knowledge_remember: {
          default: {
            action: "Remember knowledge",
            running: "Remembering knowledge",
            done: "Remembered knowledge",
          },
        },
        knowledge_resume: {
          default: {
            action: "Resume knowledge publication",
            running: "Resuming knowledge publication",
            done: "Resumed knowledge publication",
          },
        },
        knowledge_revision: {
          default: {
            action: "Inspect knowledge revision",
            running: "Inspecting knowledge revision",
            done: "Inspected knowledge revision",
          },
        },
        knowledge_save_page: {
          default: {
            action: "Save knowledge page",
            running: "Saving knowledge page",
            done: "Saved knowledge page",
          },
        },
        knowledge_source_check: {
          default: {
            action: "Check ingested source",
            running: "Checking ingested source",
            done: "Checked ingested source",
          },
        },
        knowledge_status: {
          default: {
            action: "Check knowledge status",
            running: "Checking knowledge status",
            done: "Checked knowledge status",
          },
        },
        knowledge_supersede: {
          default: {
            action: "Supersede claims",
            running: "Superseding claims",
            done: "Superseded claims",
          },
          restore: {
            action: "Restore superseded claims",
            running: "Restoring superseded claims",
            done: "Restored superseded claims",
          },
        },
        knowledge_timeline: {
          default: {
            action: "Read knowledge timeline",
            running: "Reading knowledge timeline",
            done: "Read knowledge timeline",
          },
        },
        knowledge_unmerge: {
          default: {
            action: "Undo a page merge",
            running: "Undoing a page merge",
            done: "Undid a page merge",
          },
        },
        knowledge_verify: {
          default: {
            action: "Verify knowledge publication",
            running: "Verifying knowledge publication",
            done: "Verified knowledge publication",
            checked: "Checked knowledge publication",
          },
        },
        knowledge_withdraw: {
          default: {
            action: "Withdraw knowledge",
            running: "Withdrawing knowledge",
            done: "Withdrew knowledge",
          },
        },
        intent: {
          create: {
            action: "Create standing instruction",
            running: "Creating standing instruction",
            done: "Created standing instruction",
          },
          list: {
            action: "List standing instructions",
            running: "Listing standing instructions",
            done: "Listed standing instructions",
          },
          cancel: {
            action: "Cancel standing instruction",
            running: "Canceling standing instruction",
            done: "Canceled standing instruction",
          },
        },
        memory_forget: {
          default: { action: "Forget memory", running: "Forgetting memory", done: "Forgot memory" },
        },
        memory_recall: {
          default: {
            action: "Search saved memories",
            running: "Searching saved memories",
            done: "Searched saved memories",
          },
        },
        memory_store: {
          default: { action: "Save memory", running: "Saving memory", done: "Saved memory" },
        },
        wiki_apply: {
          default: {
            action: "Apply wiki changes",
            running: "Applying wiki changes",
            done: "Applied wiki changes",
          },
        },
        wiki_get: {
          default: {
            action: "Read wiki page",
            running: "Reading wiki page",
            done: "Read wiki page",
          },
        },
        wiki_lint: {
          default: { action: "Check wiki", running: "Checking wiki", done: "Checked wiki" },
        },
        wiki_search: {
          default: { action: "Search wiki", running: "Searching wiki", done: "Searched wiki" },
        },
        wiki_status: {
          default: {
            action: "Check wiki status",
            running: "Checking wiki status",
            done: "Checked wiki status",
          },
        },
        image_generate: {
          generate: {
            action: "Generate image",
            running: "Generating image",
            done: "Generated image",
            requested: "Requested image generation",
          },
          list: {
            action: "List image models",
            running: "Listing image models",
            done: "Listed image models",
          },
          status: {
            action: "Check image generation",
            running: "Checking image generation",
            done: "Checked image generation",
          },
          review: {
            action: "Review generated images",
            running: "Reviewing generated images",
            done: "Reviewed generated images",
          },
          deliver: {
            action: "Approve image delivery",
            running: "Approving image delivery",
            done: "Approved image delivery",
          },
          supersede: {
            action: "Suppress image delivery",
            running: "Suppressing image delivery",
            done: "Suppressed image delivery",
          },
        },
        music_generate: {
          generate: {
            action: "Generate music",
            running: "Generating music",
            done: "Generated music",
            requested: "Requested music generation",
          },
          list: {
            action: "List music models",
            running: "Listing music models",
            done: "Listed music models",
          },
          status: {
            action: "Check music generation",
            running: "Checking music generation",
            done: "Checked music generation",
          },
        },
        video_generate: {
          generate: {
            action: "Generate video",
            running: "Generating video",
            done: "Generated video",
            requested: "Requested video generation",
          },
          list: {
            action: "List video models",
            running: "Listing video models",
            done: "Listed video models",
          },
          status: {
            action: "Check video generation",
            running: "Checking video generation",
            done: "Checked video generation",
          },
        },
        transcripts: {
          start: {
            action: "Start transcription",
            running: "Starting transcription",
            done: "Started transcription",
          },
          stop: {
            action: "Stop transcription",
            running: "Stopping transcription",
            done: "Stopped transcription",
          },
          status: {
            action: "Check transcription",
            running: "Checking transcription",
            done: "Checked transcription",
          },
          import: {
            action: "Import transcript",
            running: "Importing transcript",
            done: "Imported transcript",
          },
          summarize: {
            action: "Summarize transcript",
            running: "Summarizing transcript",
            done: "Summarized transcript",
          },
        },
        tts: {
          default: {
            action: "Generate speech",
            running: "Generating speech",
            done: "Generated speech",
          },
        },
        pdf: {
          default: { action: "Read PDF", running: "Reading PDF", done: "Read PDF" },
        },
        local_image: {
          default: {
            action: "Inspect image locally",
            running: "Inspecting image locally",
            done: "Inspected image locally",
          },
          task_ocr: {
            action: "Read text in image",
            running: "Reading text in image",
            done: "Read text in image",
          },
        },
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
            actionWithQuery: "Search the web for “{query}”",
            runningWithQuery: "Searching the web for “{query}”",
            doneWithQuery: "Searched the web for “{query}”",
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