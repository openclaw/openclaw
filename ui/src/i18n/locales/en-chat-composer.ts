import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    view: {
      activityDetails: "View activity details",
      workingDetails: "Agent is working. View details",
    },
    composer: {
      running: "running",
      composerInput: "Chat composer",
      usePrediction: "Use suggestion",
      predictionShortcut: "Tab",
      dismissPrediction: "Dismiss suggestion",
      predictionAvailable:
        "Suggested message: {text}. Press Tab to use it, or Escape to dismiss. It will not be sent automatically.",
      emojiSuggestions: "Emoji suggestions",
      placeholder: "Message {name}",
      emptyHint: "Write a message to send.",
      preparingModel: "Preparing model...",
      responding: "{name} is responding...",
      sendingMessage: "Sending message...",
      working: "{name} is working...",
      runDone: "Done",
      runInterrupted: "Interrupted",
      localCancellationCaveat: "Cancellation requested; the local model may still be finishing.",
      runStatus: "Run status: {status}",
      compactingContext: "Compacting context...",
      contextCompacted: "Context compacted",
      fallbackActive: "Fallback active: {model}",
      modelFallbackEvent: "Model fallback: {from} → {to}",
      modelRestoredEvent: "Returned to selected model: {from} → {to}",
      fallbackCleared: "Fallback cleared: {model}",
      fallbackSelected: "Selected: {model}",
      fallbackCurrent: "Active: {model}",
      fallbackPrevious: "Previous fallback: {model}",
      fallbackReason: "Reason: {reason}",
      fallbackAttempts: "Attempts: {attempts}",
      cancelReply: "Cancel reply",
      attachmentPreview: "Attachment preview",
      browserAnnotation: "Browser annotation",
      browserAnnotationPreview: "Browser annotation preview",
      browserAnnotationRegion: "{count} marked region",
      browserAnnotationRegions: "{count} marked regions",
      browserAnnotationInspectedElement: "Element inspected",
      browserAnnotationRemoved: "Browser annotation removed.",
      browserAnnotationUndoUnavailable:
        "Undo is unavailable because the browser annotation limit has been reached.",
      preparingAttachments: "Preparing attachments…",
      preparingAttachmentCount: "Preparing {count} attachment",
      preparingAttachmentsCount: "Preparing {count} attachments",
      removeAttachment: "Remove attachment",
      removeNamedAttachment: "Remove {name}",
      removeBrowserAnnotation: "Remove browser annotation: {name}",
      addAttachment: "Add attachment",
      attach: "Add attachment…",
      attachPhoto: "Photo",
      attachMedia: "Media",
      attachFileOption: "File",
      menu: {
        toolAccess: {
          loadFailed: "Couldn’t load tools.",
        },
        offlineBlocked: "Connect to the gateway to change session capabilities.",
        adminBlocked: "Admin access is required to manage MCP servers.",
        savingBlocked: "Wait for the current session capability change to finish.",
      },
      overrides: {
        count: "{count} overrides",
        countOne: "{count} override",
        clear: "Clear session overrides",
      },
      contextUsage: {
        title: "Context usage details",
        open: "Open context usage details",
        summary: "Session context usage: {used} of {limit} ({pct}%)",
        contextWindow: "Context window",
        promptBudget: "Prompt budget",
        latestRun: "Latest run",
        inputShort: "In",
        outputShort: "Out",
        costShort: "Cost",
        latestRunTokens: "Latest run tokens",
        estimatedCost: "Est. cost",
        planUsage: "Plan usage",
        openUsage: "Open usage dashboard",
        resets: "Resets {time}",
        usageCredits: "Usage credits",
        budgetValue: "{used} of {limit}",
        limitFiveHour: "5-hour",
        limitWeekly: "Weekly",
        limitDaily: "Daily",
        limitHours: "{hours}-hour",
      },
      takePhoto: "Take photo",
      cameraAccessFailed: "Unable to access the camera.",
      cameraBusy: "The camera is busy or unavailable to the browser.",
      cameraFallback: "Camera {number}",
      cameraInput: "Camera",
      cameraListUnsupported: "This browser cannot list cameras.",
      cameraNoneFound: "No camera was found.",
      cameraPageInactive: "Cameras are unavailable while this page is inactive.",
      cameraPermissionBlocked:
        "Camera access is blocked. Allow camera access in browser site settings.",
      cameraPreview: "Camera preview",
      dismissVoiceInputError: "Dismiss voice input error",
      microphoneAccessFailed: "Unable to access microphone inputs.",
      microphoneAccessPending:
        "Waiting for microphone access. Bring this tab to the foreground and allow access if prompted.",
      microphoneBusy: "Microphone inputs are busy or unavailable to the browser.",
      microphoneStopped: "Microphone input stopped. Choose an available input and start again.",
      microphoneFallback: "Microphone {number}",
      microphoneInput: "Microphone input",
      microphoneAppliesNextSession: "Changes apply when you start your next Talk session.",
      microphoneListUnsupported: "This browser cannot list microphone inputs.",
      noCameras: "No additional cameras found",
      noMicrophones: "No additional microphones found",
      microphoneNoneFound: "No microphone found. Plug one in and it appears here.",
      microphonePageInactive: "Microphone inputs are unavailable while this page is inactive.",
      microphonePermissionBlocked:
        "Microphone access is blocked. Allow it in browser site settings to list inputs.",
      realtimeTalkCapability: "Tap to talk",
      dictationCapability: "Dictation",
      realtimeTalkProviderUnavailable: "No realtime voice provider is configured.",
      dictationProviderUnavailableShort: "No transcription provider is configured.",
      talkCapabilityChecking: "Checking provider availability…",
      talkCapabilityUnknown: "Provider availability could not be verified.",
      openRealtimeTalkSettings: "Talk settings",
      openDictationSettings: "Transcription setup",
      configureCapability: "Configure",
      holdToRecordSetting: "Hold microphone button to start dictation",
      holdToDictate: "Hold to start dictation",
      holdToRecordSettingDescription:
        "Hold until dictation starts, then release and keep speaking. Tap Stop to insert the transcript.",
      dictationAudioUnsupported: "The Gateway returned an unsupported dictation audio format.",
      dictationBrowserAudioUnsupported: "This browser cannot capture dictation audio at 8 kHz.",
      dictationDisconnected: "Dictation stopped because the Gateway disconnected.",
      dictationFailed: "Dictation failed.",
      dictationInterruptedRecovery:
        "Captured text was inserted. Check your connection and try again.",
      dictationStartRecovery: "Check microphone access and transcription settings, then try again.",
      dictationFinalizing: "Finishing dictation…",
      dictationListening: "Listening…",
      dictationStopAndKeep: "Stop and keep text",
      dictationProviderUnavailable:
        "No transcription provider is configured for dictation. Choose one in Settings to dictate.",
      realtimeTalkCancellationRejected: "Realtime output cancellation was not accepted.",
      realtimeTalkMissingTurnIdentity: "Realtime output is missing its turn identity.",
      realtimeTalkRelayUnresponsive:
        "Talk ended because the Gateway has not acknowledged microphone audio for 30 seconds. Check the connection and start Talk again.",
      realtimeTalkRequiresMicrophone: "Realtime voice input requires browser microphone access.",
      selectedMicrophoneUnavailable:
        "The selected microphone is unavailable. Choose another input or System default.",
      selectedCameraUnavailable:
        "The selected camera is unavailable. Choose another camera or System default.",
      startVoiceInput: "Start voice input",
      voiceGestureHint: "Tap to talk · Hold to start dictation",
      stillListening: "Still listening",
      stopVoiceInput: "Stop voice input",
      systemDefaultMicrophone: "System default",
      useSystemDefaultMicrophoneForCall: "Use System default for this call",
      systemDefaultCamera: "System default",
      switchCamera: "Switch camera",
      turnCameraOff: "Turn camera off",
      turnCameraOn: "Turn camera on",
      voiceTranscript: "Voice transcript",
    },
    queue: {
      reviewEdit: "Review edit",
      reloadBlocked: "Save or cancel your queued message edit before reloading.",
      memoryOnlyReloadBlocked:
        "A pending message is only saved in this tab. Keep this tab open until it is sent, or copy it before discarding it and reloading.",
      memoryOnlyReview: "Review pending input",
      memoryOnlyTitle: "Unsent pending message",
      memoryOnlyDescription:
        "This pending message stays only in this tab. Copy its text or download its attachments before discarding the local copy to refresh. Discarding does not cancel a message already received by the Gateway.",
      memoryOnlyText: "Message text",
      memoryOnlyDiscard: "Discard local copy and refresh",
      memoryOnlyChanged:
        "The pending input changed or is being edited. It has not been discarded; review the current input before refreshing.",
      memoryOnlyUnavailable:
        "The pending input could not be opened. It remains protected in this tab; try Review pending input again.",
      connectionPending: "Finishing connection recovery. Try sending again when it is ready.",
      editSourceChanged:
        "This queued message changed while you were editing. Your edit is still here. Copy it, cancel the edit, and review the queue before trying again.",
      editStorageFailed:
        "Your edit could not be saved in this browser. Keep this tab open and copy your edit before freeing browser storage, then try again.",
      full: "The message queue is full. Wait for a queued message to send or remove one, then try again.",
      initialTurnPending:
        "The initial message is unresolved. Reconnect if needed, then review it before sending another message.",
      notSent: "Not sent",
      retry: "Retry",
      retryQueuedMessage: "Retry queued message",
      discard: "Discard",
      discardPendingMessage:
        "Discard this local pending copy. This does not cancel a message already received by the Gateway.",
      steer: "Steer",
      steerQueuedMessage: "Steer queued message",
      removeQueuedMessage: "Remove queued message",
      reorderQueuedMessage: "Reorder queued message with the arrow keys",
      reorderUnavailable: "This message holds its place and cannot be reordered",
      editQueuedMessage: "Edit queued message",
      moreActions: "More queued message actions",
      cancelEdit: "Cancel editing and keep the queued message",
      states: {
        applyingSettings: "Applying chat settings",
        blockedByReview:
          "Queue paused. Review or discard the earlier held message in the conversation.",
        runningCommand: "Running command",
        waitingForReconnect: "Waiting for reconnect",
        editing: "Editing",
        needsReview: "Needs review",
      },
      imageCount: "Image ({count})",
    },
    mentions: {
      menu: "Mention a person",
      empty: "No people found",
      truncated: "Keep typing to find more people.",
      online: "Online",
      offline: "Offline",
      unavailable: "Could not load people. Try again.",
      accessDenied: "Mention access denied. Sign in or contact an admin.",
      profileUnavailable: "Profile unverified. Reconnect or contact an admin.",
      rejected: "Mention search rejected. Check access or use another chat.",
      limit: "You can mention up to 10 people per message.",
      selectedLabel: "Will notify",
      selected: "Will notify: {names}",
      remove: "Remove mention",
      restoreFailed:
        "Mention selection could not be restored. Edit this message and select its recipients again.",
      unsupported:
        "Human mentions are not available in this mode. Remove the selected mentions or send from a normal chat.",
    },
    permissions: {},
    voice: {
      asking: "Asking OpenClaw...",
      replyFailed: "The voice reply was interrupted. Start Talk again to retry.",
      replyTimedOut:
        "Talk stopped waiting. The agent's answer will appear in chat when it finishes.",
      preparing: "Preparing voice session...",
      connecting: "Connecting voice input...",
      listening: "Listening...",
      selectionFailed: "Could not change voices. Restart the call.",
      selectionTimedOut: "Voice change timed out. Restart the call.",
      selectionConfirmationFailed: "Voice change unconfirmed.",
    },
    sendErrors: {
      outboxPayloadCapacity:
        "Browser attachment storage is full. Try a smaller batch or send/discard queued messages to free space. No new message was sent; your input is retained.",
      outboxPayloadUnavailable:
        "Browser attachment storage is unavailable. Allow browser storage and close older dashboard tabs before reconnecting and retrying. No new message was sent.",
      outboxPayloadMissing:
        "Queued attachments are missing or unreadable. This may be a stale copy from another tab. Check the conversation, then discard this row and attach the files again if needed. No new message was sent.",
      activeLeafChanged: "The session switched branches — review and resend.",
    },
    outboxRecoveryReviewTitle: "Review in this chat?",
    outboxRecoveryConfirm: "Add this saved copy to “{chat}” for review? Nothing will be sent.",
    outboxRecoveryRestore: "Restore",
    outboxRecoveryConflict:
      "Keep or clear the draft and pending messages in this chat first, or open another non-Incognito chat. Your saved copy is unchanged.",
    outboxRecoveryStorageFailed:
      "We could not access your saved messages. Reload to try again. Do not clear browser site data if you want to keep them.",
    outboxRecoveryFull:
      "There are more saved messages than we can show. Review or delete the copies below to make room. The remaining messages are still saved in this browser.",
    outboxRecoveryDraft: "Draft",
    outboxRecoveryQueued: "Unsent",
    outboxRecoverySource: "from {chat}",
    outboxRecoveryUpdated: "Last updated {time}",
    outboxRecoveryGoal: "Includes an unsent goal change",
    outboxRecoveryReply: "Reply to: {text}",
    outboxRecoveryAttachments: "Attachments: {files}",
    outboxRecoveryAttachmentMissing:
      "An attachment could not be loaded. Review the message and reattach the file before sending.",
    outboxRecoveryDelete: "Delete",
    outboxRecoveryDeleteTitle: "Delete this saved copy?",
    outboxRecoveryDeleteConfirm:
      "This removes the draft and any saved messages or attachments shown with it from this browser. It cannot be undone. Messages already sent to a chat will not be deleted.",
    outboxRecoveryDeleteConflict:
      "This saved copy changed while you were reviewing it. Nothing was deleted. Reload and review it again.",
    attachments: {
      allowImage: "Allow image",
      attachedFile: "Attached file",
      audio: "Audio",
      download: "Download",
      expand: "Open {filename} in the side panel",
      open: "Open",
      previewUnavailable: "Preview unavailable",
      textPreviewUnavailable:
        "Could not preview this file. Text previews require UTF-8 files up to 256 KiB. Download it to read the full file.",
      htmlPreviewUnavailable:
        "Could not preview this HTML file. HTML previews require UTF-8 files up to 2 MiB. Download it to read the full file.",
      readFailed: "Could not attach file. Try again.",
      imagesOnly: "Side chat accepts image attachments only.",
      tooLarge: "Too large to send: {names}{more}",
      tooLargeToast: "File too large. Try a smaller file.",
      openOriginal: "Open original",
      compressToFit: "Compress to fit",
      retryCompression: "Retry compression",
      compressionHint:
        "Video is too large. Compress a copy on this device; the original stays unchanged.",
      compressing: "Compressing · {progress}%",
      compressionUnsupported: "This browser cannot compress this video.",
      compressionTooLarge: "Video is still too large. Try a smaller file.",
      compressionFailed: "Could not compress video. Try again.",
      showInTextField: "Show in text field",
      pastedText: "Pasted text",
      outsideAllowedFolders: "Outside allowed folders",
      unavailable: "Unavailable",
      failureDeliveryFailed: "Delivery failed. Try sending this file again.",
      failureInvalidReference:
        "Use a public HTTPS URL without credentials or attach a local file by a safe path.",
      failureFileNotFound: "File not found. Check the path and try again.",
      failureUnsupportedFormat:
        "This file type cannot be attached here. If it is saved in this session, download it from Files, or ask for a ZIP containing the original file.",
      history: "History",
      image: "Image",
      notSent: "Not sent",
      omittedFromHistory: "Omitted from history",
      omittedFromHistoryWithSize: "Omitted from history · {size}",
      video: "Video",
    },
    privateDraftReload: {
      blocked: "An unsent Incognito draft is keeping this tab open. Review it before refreshing.",
      review: "Review private draft",
      title: "Unsent Incognito draft",
      description:
        "This draft stays only in this tab. Copy its text or download its attachments before discarding it to refresh. Keeping this tab open leaves the draft unchanged.",
      text: "Draft text",
      copy: "Copy text",
      goal: "This draft includes an unsent goal change.",
      reading:
        "Some attachments are still being read. Keep this tab open, then review the draft again when they finish.",
      changed:
        "The draft changed while you were reviewing it. It has not been discarded; review the current draft before refreshing.",
      copyFailed:
        "The text could not be copied. Select it in the draft field and copy it manually.",
      attachmentUnavailable:
        "This attachment is no longer available to download. Keep the draft open and recover the original file before discarding it.",
      download: "Download {name}",
      discard: "Discard this draft and refresh",
      keep: "Keep in this tab",
      unavailable:
        "The private draft could not be opened. It remains in this tab; try Review private draft again.",
    },
    progressLabels: {
      shelling: "Shelling",
      scuttling: "Scuttling",
      clawing: "Clawing",
      pinching: "Pinching",
      molting: "Molting",
      bubbling: "Bubbling",
      tiding: "Tiding",
      reefing: "Reefing",
      cracking: "Cracking",
      sifting: "Sifting",
      brining: "Brining",
      nautiling: "Nautiling",
      krilling: "Krilling",
      barnacling: "Barnacling",
      lobstering: "Lobstering",
      tidepooling: "Tidepooling",
      pearling: "Pearling",
      snapping: "Snapping",
      surfacing: "Surfacing",
    },
  },
} satisfies TranslationMap;

export const registerChatComposerEnglish = Object.assign(
  () => {
    const {
      view,
      composer,
      queue,
      mentions,
      permissions,
      voice,
      sendErrors,
      attachments,
      privateDraftReload,
      progressLabels,
      ...outboxRecovery
    } = catalog.chat;
    Object.assign(en.chat, outboxRecovery);
    Object.assign(en.chat.view, view);
    const { menu, ...composerLabels } = composer;
    Object.assign(en.chat.composer, composerLabels);
    en.chat.composer.menu ??= menu;
    Object.assign(en.chat.queue, queue);
    Object.assign(en.chat.mentions, mentions);
    Object.assign(en.chat.permissions, permissions);
    Object.assign(en.chat.voice, voice);
    Object.assign(en.chat.sendErrors, sendErrors);
    Object.assign(en.chat.attachments, attachments);
    Object.assign(en.chat.privateDraftReload, privateDraftReload);
    Object.assign(en.chat.progressLabels, progressLabels);
  },
  { catalog },
);
