// Control UI startup English. Lazy fragments retain empty namespace anchors here
// so host-side composition preserves grouped translation-memory source order.
import type { TranslationMap } from "../lib/types.ts";
import * as agentEn from "./en-agents.ts";

type EnglishCatalog = TranslationMap & {
  languages: TranslationMap;
  onboarding: TranslationMap & { memoryImport: TranslationMap };
  execApproval: TranslationMap & { labels: TranslationMap; scope: TranslationMap };
  sessionProgressCard: TranslationMap & {
    refresh: TranslationMap;
    activity: TranslationMap;
    outcome: TranslationMap;
    status: TranslationMap;
  };
  assistantPanel: TranslationMap;
  outputs: TranslationMap;
  nativeLinkMenu: TranslationMap;
  capacityMeter: TranslationMap;
  skillGroups: TranslationMap;
  skillStatus: TranslationMap;
  labsPage: TranslationMap & { swarm: TranslationMap };
  agentChip: TranslationMap;
  agentsHome: TranslationMap;
  logbook: TranslationMap;
  gatewayLogs: TranslationMap;
  standingGrants: TranslationMap;
  approvalHistory: TranslationMap;
  approvalPage: TranslationMap;
  secretsStore: TranslationMap &
    Record<
      "allowedHosts" | "allowedHostsPlaceholder" | "protectedSecret" | "agentReadable" | "hint",
      string
    >;
  pluginsPage: TranslationMap & Record<"installed" | "official" | "install", string>;
  mcpApp: TranslationMap;
  linkReader: TranslationMap;
  agentTools: TranslationMap;
  githubPublication: TranslationMap & Record<"newAction" | "capacity", string>;
  githubConnections: TranslationMap &
    Record<"title" | "mine" | "system" | "forMe" | "forSystem", string>;
  board: TranslationMap & { announcement: TranslationMap; widget: TranslationMap };
  browser: TranslationMap & { errors: TranslationMap; annotatePrompt: TranslationMap };
  pluginUi: TranslationMap & { surface: TranslationMap };
  shortcutsOverlay: TranslationMap & { title: string };
  chat: TranslationMap &
    Record<
      | "sessionAutomation"
      | "activityPills"
      | "usageLimit"
      | "providerPolicy"
      | "diskSpace"
      | "workerRuntimeInstall"
      | "subagentsPanel"
      | "reactions"
      | "sessionHeader"
      | "board"
      | "taskSuggestions"
      | "view"
      | "workspaceConflict"
      | "skillLearned"
      | "asyncQuestions"
      | "youtube"
      | "rail"
      | "thread"
      | "sessionDiscussion",
      TranslationMap
    > & {
      clawhub: TranslationMap;
      sidebar: TranslationMap;
      composer: TranslationMap;
      queue: TranslationMap;
      mentions: TranslationMap;
      permissions: TranslationMap;
      voice: TranslationMap;
      sendErrors: TranslationMap;
      sessionDetails: TranslationMap &
        Record<
          | "automationAttention"
          | "automationEmpty"
          | "automationEnabled"
          | "automationError"
          | "automationLoading"
          | "automationMore"
          | "automationPaused"
          | "automationUnavailable"
          | "automations"
          | "progressOptions",
          string
        >;
      sessionDiff: TranslationMap & Record<"title" | "show", string>;
      sessionSharing: TranslationMap & Record<"draft", string>;
      workspaceFiles: TranslationMap & Record<"copyPath", string>;
      toolCards: TranslationMap & Record<"activity" | "review" | "verbs", TranslationMap>;
      systemNotice: TranslationMap &
        Record<
          | "guardian"
          | "restartRecovery"
          | "automationRecovery"
          | "gatewayRestarted"
          | "cliHarnessContext"
          | "claudeCliTaskNotification"
          | "pluginSteering",
          TranslationMap
        >;
      mermaid: TranslationMap;
      questions: TranslationMap;
      imageLightbox: TranslationMap;
      mediaPlayer: TranslationMap;
      attachments: TranslationMap;
      privateDraftReload: TranslationMap;
      startupStatus: TranslationMap;
      progressLabels: TranslationMap;
      pendingInputs: TranslationMap & { agentUpdate: TranslationMap };
      sessionSuggestions: TranslationMap & { state: TranslationMap };
      catalog: TranslationMap;
      sessionRoute: TranslationMap;
      codeBlock: TranslationMap;
      commandResults: TranslationMap & { fast: TranslationMap };
      commands: TranslationMap;
      detailPanel: TranslationMap;
      welcome: TranslationMap & { suggestions: TranslationMap & { whatCanYouDo: string } };
      goals: TranslationMap;
      messages: TranslationMap &
        Record<
          | "copySelection"
          | "replyingTo"
          | "message"
          | "showLess"
          | "showMore"
          | "tooLargeToDisplay"
          | "unattributedSender"
          | "toolSender"
          | "errorSender",
          string
        >;
      pullRequests: TranslationMap & Record<"open" | "draft" | "merged" | "closed", string>;
      processesPanel: TranslationMap;
    };
  aboutPage: TranslationMap &
    Record<
      | "artifactDetails"
      | "commit"
      | "built"
      | "unavailable"
      | "copyCommit"
      | "copiedCommit"
      | "gateway",
      string
    >;
  dashboardsPage: TranslationMap;
  configForm: TranslationMap &
    Record<"hideValue" | "revealValue" | "defaultValue", string> & { sections: TranslationMap };
  quickSettings: TranslationMap & {
    appearance: TranslationMap & Record<"lobsterVisits", string>;
    personal: TranslationMap & Record<"browserOnly", string>;
  };
  activityFeed: TranslationMap & Record<"viewingNow" | "showing", string>;
  terminal: TranslationMap &
    Record<"title" | "open" | "toggle" | "unavailable" | "startCancelled", string>;
  configPage: TranslationMap;
  profilePage: TranslationMap & {
    personalInstructions: TranslationMap;
    identity: TranslationMap &
      Record<
        | "title"
        | "menuLabel"
        | "menuButtonLabel"
        | "description"
        | "avatar"
        | "chooseAvatar"
        | "displayName"
        | "linkedEmails",
        string
      >;
  };
  connection: TranslationMap & {
    browserSignIn: TranslationMap;
    switchGateway: TranslationMap;
    help: TranslationMap;
  };
  channels: TranslationMap;
  agents: TranslationMap & { overview: TranslationMap };
  configView: TranslationMap &
    Record<
      | "adminRequired"
      | "recoveryNotRestored"
      | "recoveryUnknown"
      | "recoveryBackup"
      | "discardUnconfirmed"
      | "writeGatewayChanged"
      | "writeUnconfirmed"
      | "reloadBlocked"
      | "rawDraftBlocksApply"
      | "rawDraftBlocksFormEdit"
      | "rawDraftUnverified"
      | "fileOpenedOnGateway",
      string
    >;
  custodian: TranslationMap & { autoSetup: TranslationMap & { thisComputer: string } };
  debug: TranslationMap & {
    lanes: TranslationMap & Partial<Record<"lane" | "active" | "queued" | "blocked", string>>;
    overlay: TranslationMap & { title: string } & Partial<
        Record<
          | "eyebrow"
          | "move"
          | "minimize"
          | "expand"
          | "lanes"
          | "status"
          | "activeRuns"
          | "events"
          | "cpu"
          | "memory"
          | "delayP99",
          string
        >
      >;
  };
  // Lazy en-devices.ts assigns into this namespace.
  devices: TranslationMap & { pairing: TranslationMap };
  desktop: TranslationMap &
    Record<"title" | "openWindow" | "unavailable" | "toggle" | "reconnect" | "connecting", string>;
  worktrees: TranslationMap;
  sessionHovercard: TranslationMap & { states: TranslationMap; checks: TranslationMap } & Record<
      | "ariaLabel"
      | "linkedChannel"
      | "moreParticipants"
      | "moreParticipantsLabel"
      | "projectLabel"
      | "workspaceLabel"
      | "branchLabel"
      | "runsOn"
      | "machineLabel"
      | "machineCpu"
      | "machineMemory"
      | "more"
      | "changedFile"
      | "changedFiles",
      string
    >;
  filePreview: TranslationMap;
  updates: TranslationMap &
    Record<"confirm" | "dialog" | "triage" | "report", TranslationMap> & {
      run: TranslationMap &
        Partial<Record<"restarting" | "progress", string>> & { phase: TranslationMap };
    };
  login: TranslationMap;
  mcpServers: TranslationMap;
  mcpPage: TranslationMap;
  modelSetup: TranslationMap & {
    candidates: TranslationMap;
    failure: TranslationMap;
    failureGuidance: TranslationMap;
  };
  newSession: TranslationMap &
    Record<"title" | "hint" | "placementReloadBlocked" | "discardUnsavedAndReload", string>;
  commandPalette: TranslationMap;
  palette: TranslationMap & {
    placeholder: string;
    attachmentPrompt: string;
    categories: TranslationMap & { navigation: string };
  };
  sessionsView: TranslationMap &
    Record<
      | "pullRequestCount"
      | "subagentPrefix"
      | "automationPrefix"
      | "actionRequiresConnection"
      | "actionUnavailable"
      | "actionRequiresScope"
      | "actionRequiresOwnership"
      | "draftCleanupFailed"
      | "createdBy"
      | "ownedBy"
      | "archivedBy"
      | "viewingNow"
      | "owners"
      | "allOwners"
      | "involvingMe"
      | "withParticipant"
      | "withMoreParticipants"
      | "snoozeWakes"
      | "snoozeTomorrowTime"
      | "user"
      | "assistant"
      | "opensAsDashboard"
      | "approvalNeeded"
      | "messageNeedsAttention"
      | "messagesNeedAttention"
      | "unsentDraft"
      | "noArchivedSessions"
      | "status"
      | "statusLive"
      | "statusIdle"
      | "statusUnknown"
      | "statusQueued"
      | "statusRunning"
      | "statusDone"
      | "statusFailed"
      | "statusInterrupted"
      | "statusKilled"
      | "statusTimeout"
      | "waitingForAnswer"
      | "waitingForApproval"
      | "questionsNeedAnswer"
      | "approvalsNeedApproval"
      | "attentionMore"
      | "runFailedReason"
      | "childRunFailedReason"
      | "runErrorTimedOut"
      | "runErrorUnknown"
      | "attentionRequired"
      | "openSession"
      | "provider"
      | "lastActive"
      | "activeRun"
      | "subagentsWorking"
      | "showChildSessions"
      | "hideChildSessions"
      | "childSessions"
      | "showMoreChildren"
      | "archived"
      | "unread"
      | "automationAttached"
      | "incognito"
      | "incognitoLabel"
      | "incognitoDescription"
      | "incognitoLimits"
      | "cloudWorkerPlacement"
      | "placementWorkspaceConflict"
      | "placementWorkspaceConflicts"
      | "cloudWorkerDiskWarning"
      | "cloudWorkerDiskCritical"
      | "cloudWorkerDescendantConflict"
      | "cloudWorkerDescendantConflicts"
      | "sessionColor"
      | "pinSession"
      | "unpinSession"
      | "forkedSession"
      | "archiveSession"
      | "restoreSession"
      | "deleteSessionStale"
      | "deleteSessionsStale"
      | "groupMenu"
      | "groupOptions"
      | "newSessionInGroup"
      | "groupDefaultsStale"
      | "moveToTopLevel",
      string
    > & { colors: TranslationMap };
  skillWorkshop: TranslationMap;
  systems: TranslationMap;
  talkPage: TranslationMap;
  usage: TranslationMap & { overview: TranslationMap; details: TranslationMap };
};

const startupEnglish = {
  pluginUi: {
    retryView: "Retry plugin view",
    inlineLoading: "Loading plugin view…",
    inlineUnavailable:
      "This view is unavailable. Check that its plugin is installed, enabled, and allowed for your account. Reload the conversation after installing or updating the plugin.",
    dashboardTitle: "Session dashboard",
    customPluginsDisabled: "Custom plugin UI is off",
    customPluginsEnableHint: "Enable Custom plugin UI in Labs.",
    openLabs: "Open Labs",
    surface: {},
  },
  capacityMeter: {},
  agentsHome: {
    loadFailed: "Could not load agents. Try again.",
  },
  outputs: {
    dashboard: "Dashboard",
  },
  common: {
    uploadsDisabled: "File and image uploads are disabled.",
    health: "Health",
    ok: "OK",
    yes: "Yes",
    no: "No",
    default: "Default",
    active: "Active",
    loading: "Loading…",
    gatewayStarting: "Gateway starting…",
    refreshing: "Refreshing…",
    offline: "Offline",
    connect: "Connect",
    connected: "Connected",
    refresh: "Refresh",
    retry: "Retry",
    staleData: "Showing stale data.",
    reload: "Reload",
    reset: "Reset",
    restore: "Restore",
    unarchive: "Unarchive",
    undo: "Undo",
    probe: "Check connection",
    call: "Call",
    confirm: "Confirm",
    dontAskAgain: "Don't ask me again",
    cancel: "Cancel",
    close: "Close",
    previous: "Previous",
    next: "Next",
    continue: "Continue",
    back: "Back",
    create: "Create",
    copy: "Copy",
    copied: "Copied!",
    copyFailed: "Copy failed",
    copyCode: "Copy code",
    copyTable: "Copy table",
    expandTable: "Expand table",
    expandedTable: "Expanded table",
    closeTable: "Close expanded table",
    resizeSplitView: "Resize split view",
    delete: "Delete",
    remove: "Remove",
    dismiss: "Dismiss",
    dismissAndDontShowAgain: "Dismiss and don't show again",
    unselect: "Unselect",
    enabled: "Enabled",
    disabled: "Disabled",
    failed: "Failed",
    none: "none",
    na: "n/a",
    never: "never",
    justNow: "just now",
    now: "now",
    unknown: "Unknown",
    configured: "Configured",
    running: "Running",
    queued: "Queued",
    completed: "Completed",
    cancelled: "Cancelled",
    linked: "Linked",
    mode: "Mode",
    system: "System",
    light: "Light",
    dark: "Dark",
    baseUrl: "Base URL",
    lastStart: "Last start",
    lastProbe: "Last connection check",
    lastConnect: "Last connect",
    lastMessage: "Last message",
    authAge: "Auth age",
    credential: "Credential",
    audience: "Audience",
    publicKey: "Public Key",
    probeOk: "Connection check passed",
    probeFailed: "Connection check failed",
    reloadConfig: "Reload Config",
    multiSelect: {
      addCustom: "Add “{value}”",
      noMatches: "No matches",
      remove: "Remove {value}",
    },
    loadConfig: "Load config",
    loadApprovals: "Load approvals",
    settingsSections: "Settings sections",
    version: "Version",
    docs: "Docs",
    learnMore: "Learn more",
    colorMode: "Color mode",
    colorModeOption: "Color mode: {mode}",
    search: "Search",
    pickerNoMatches: "No matches",
    save: "Save",
    saving: "Saving…",
    saveAndPublish: "Save & Publish",
    importing: "Importing…",
    importFromRelays: "Import from Relays",
    showAdvanced: "Show Advanced",
    hideAdvanced: "Hide Advanced",
    unsavedChanges: "You have unsaved changes",
    working: "Working…",
    showQr: "Show QR",
    relink: "Relink",
    waitForScan: "Wait for scan",
    logout: "Logout",
    skipToMainContent: "Skip to main content",
  },
  focus: {
    unsupported: "This focused view is not supported.",
  },
  shortcutsOverlay: { title: "Keyboard shortcuts" },
  optionCard: {
    recommended: "Recommended",
    skip: "Skip for now",
  },
  nativeConversation: {
    openDashboardFailed: "Couldn't open that page in the Dashboard",
  },
  nativeLinkMenu: {},
  browserLinkPreferences: {
    openInControlUi: "Open links in Control UI browser",
  },
  filePreview: {
    bundle: {},
    label: "Support files",
  },
  mcpApp: {},
  sessionHovercard: {
    ariaLabel: "Session information",
    linkedChannel: "Linked to {channel}",
    moreParticipants: "+{count}",
    moreParticipantsLabel: "{count} more participants",
    projectLabel: "Project",
    workspaceLabel: "Workspace",
    branchLabel: "Branch",
    runsOn: "Runs on {providerId} · {profileId}",
    machineLabel: "Machine",
    machineCpu: "{cpu} vCPU",
    machineMemory: "{memory} GB",
    more: "+{count} more",
    changedFile: "{count} file",
    changedFiles: "{count} files",
    states: {},
    checks: {},
  },
  sessionProgressCard: {
    composerTitle: "Task progress",

    clearFailed: "Could not clear saved progress card.",
    refresh: {},

    activity: {},
    outcome: {},

    status: {},
    receipt: {
      updating: "Updating progress",
      failed: "Progress update failed",
      skipped: "Progress update skipped",
      updated: "Progress updated — {completed}/{total} · {current}",
      noteUpdated: "Progress note updated",
      cleared: "Progress cleared",
    },
  },
  channels: {
    lastError: {},
    refreshingStaleSnapshot: {},
    hub: {},
    pairing: {},
    setup: {},
    config: {},
    generic: {},
    discord: {},
    googleChat: {},
    imessage: {},
    signal: {},
    slack: {},
    telegram: {},
    whatsapp: {
      loggedOut: "Logged out.",
      logoutNotCleared:
        "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup.",
    },
  },
  agentStartup: {
    title: "Starting up",
    description: "The agent is getting ready. This view will load automatically.",
    short: "Starting up…",
  },
  lazyView: {
    errorTitle: "Panel failed to load",
    genericSubtitle: "Something went wrong while loading this panel.",
    staleTitle: "This view could not load",
    staleSubtitle:
      "Some interface files could not be downloaded. Check your connection, then reload.",
    reloading: "Reloading…",
    retry: "Retry",
    stylesFailed: "Styles failed to load, so the page may look broken.",
  },
  communityInvite: {
    title: "Pull up a chair.",
    body: "There’s a place for you in the AI future. Join the Community on Reddit, Discord, and X.",
    join: "Join",
    follow: "Follow",
    dismissForever: "Dismiss and don't show again",
    dismissFailed: "Invitation dismissed, but your preference couldn't be saved.",
    joinPlatform: "Join the OpenClaw community on {platform}",
    followPlatform: "Follow OpenClaw on {platform}",
  },
  updates: {
    campaign: {
      countdown: "Updating in {time}",
      waitingForIdle: "Waiting for active work · forced update in {time}",
      held: "Update held · resumes in {time}",
      applying: "Applying update…",
    },

    run: {
      phase: {},
    },
    confirm: {},
    target: {
      version: "v{version}",
      commitBehind: "{count} commit behind",
      commitsBehind: "{count} commits behind",
    },
    sidebar: {
      waitingForIdle: "Waiting for active work",
    },
    dialog: {},
    channel: {},
    installKind: {},
    page: {},
    coalescedRestart:
      "Update installed. A gateway restart is already in progress; status will refresh after it reconnects.",
    error: "Update error: {error}",
    checkError: "Could not check for updates: {error}",
    status: "Update {status}: {reason}. {guidance}",
    verificationFailedWithIdentity:
      "Update finished, but the running install does not match the expected revision. Expected {expected}, running {actual}. Run `openclaw triage` on the Gateway host before retrying.",
    handoffTimeout:
      "Update completion was not confirmed. Run `openclaw triage` on the Gateway host and inspect the result before retrying.",
    outcomeUnknown:
      "The update outcome is unknown. Run `openclaw triage` on the Gateway host and inspect the result before retrying.",
    triage: {
      hostHint:
        "If Ask OpenClaw is unavailable, run `openclaw triage` on the Gateway host to open a local coding agent for diagnosis and repair. Diagnose the cause before retrying.",
    },
    report: {},
    failureReasons: {
      dirty: "Commit or stash changes, then retry.",
      noUpstream: "Set an upstream branch, then retry.",
      notGitInstall:
        "Not a git checkout. Run `openclaw update` from the CLI for a global reinstall.",
      notOpenclawRoot:
        "Run the update from an OpenClaw checkout or use the CLI global reinstall path.",
      depsInstallFailed: "Dependency install failed. Fix the install error and retry.",
      buildFailed: "Build failed. Fix the build error and retry.",
      buildDirty:
        "The selected revision's build changed checkout files. Retry with a revision that includes its generated artifacts.",
      uiBuildFailed: "The control UI rebuild failed. Fix the UI build error and retry.",
      globalInstallFailed:
        "The global package install did not verify on disk. Retry or reinstall from the CLI.",
      restartDisabled:
        "The update was not applied because gateway restarts are disabled. Enable restarts in config, then retry.",
      restartUnavailable:
        "This global install cannot be safely replaced while restarts are disabled and no supervisor is present.",
      externalSupervisorUpdateRequired:
        "This Gateway is managed by an external supervisor. Use your server or deployment's update workflow to update OpenClaw and restart the Gateway. The Control UI and `openclaw update` cannot update this installation. No package changes or Gateway restart were attempted.",
      restartUnhealthy:
        "The replacement process never became healthy. The previous process stayed up so you can recover.",
      restartRevisionMismatch:
        "The restarted Gateway is running a different revision. Check the service install root and retry.",
      restartRevisionUnavailable:
        "The restarted Gateway could not report its revision. Check the service install root and logs before retrying.",
      alreadyCurrent: "This checkout is already at its tracked upstream revision.",
      managedServiceHandoffAlreadyRunning:
        "Another managed update is already running. Wait for it to complete, then refresh update status.",
      managedServiceHandoffUnavailable:
        "Stop the foreground Gateway, run `openclaw update`, then launch it again. For automatic updates, install a managed Gateway service.",
      doctorFailed: "Doctor repair failed. Run `openclaw doctor --non-interactive` and retry.",
      managedServiceHandoffFailed:
        "The update helper stopped before finishing. Run `openclaw update` in the terminal to see why.",
      managedServiceHandoffSpawnFailed:
        "The Gateway could not start the update helper. Run `openclaw update` in the terminal instead.",
      managedServiceHandoffParentTimeout:
        "The Gateway stayed up too long for the update helper. Start the update again, or run `openclaw update`.",
      default: "See the gateway logs for the exact failure and retry once the cause is fixed.",
    },
    failedAtStep: "The update failed at {step}: {cause}.",
    succeededVersion: "Gateway updated to v{version}.",
    succeededCommit: "Gateway updated · now on {sha}.",
    succeeded: "Gateway updated and restarted.",
  },
  devices: {
    readOnly: {},
    // The trigger and load failure stay eager; dialog copy follows its lazy renderer.
    pairing: {
      button: "Pair device",
      adminRequired: "Administrator access is required to create setup codes.",
      title: "Pair a device",
      loadFailed: "Could not load the pairing dialog. Check your connection and try again.",
    },
    binding: {},
    inventory: {},
    // Lazy: en-devices.ts registers this subtree when the Devices page renders chips.
    capabilities: {},
    execApprovals: {},
  },
  worktrees: {},
  agentChip: agentEn.agentChip,
  agentScope: agentEn.agentScope,
  newSession: {
    title: "New session",
    hint: "Pick where this session works, then say what to do.",
    placementReloadBlocked: "Recovery needs a reload. Unsaved starts will be lost.",
    discardUnsavedAndReload: "Discard unsaved starts and reload",
  },
  dashboardsPage: {},
  dashboardDocument: {
    close: "Close dashboard",
    missingSession: "No dashboard session was specified.",
    notFound: "This session could not be found.",
    unavailable: "Session dashboards are unavailable for this connection.",
    loadFailed:
      "Could not load this dashboard: {error}. Check the Gateway connection and try again.",
  },
  sessionsView: {
    pullRequestCount: "{count} pull requests",
    subagentPrefix: "Subagent:",
    automationPrefix: "Automation:",
    actionRequiresConnection: "Connect to the Gateway to change sessions.",
    actionUnavailable: "This Gateway does not support this session action.",
    actionRequiresScope: "This action requires {scope} access.",
    actionRequiresOwnership: "Only the session creator or an admin can make this change.",
    draftCleanupFailed: "Session deleted; browser draft remains. Clear site data.",
    createdBy: "Created by {name}",
    ownedBy: "Owned by {name}",
    archivedBy: "Archived by {name}",
    viewingNow: "viewing now",
    owners: "Owners",
    allOwners: "All owners",
    involvingMe: "Involving me",
    withParticipant: "with {name}",
    withMoreParticipants: "+{count} more",
    snoozeWakes: "Wakes {time}",
    snoozeTomorrowTime: "tomorrow {time}",
    user: "User",
    assistant: "Assistant",
    opensAsDashboard: "Opens as dashboard",
    approvalNeeded: "Approval needed",
    messageNeedsAttention: "{count} message needs attention",
    messagesNeedAttention: "{count} messages need attention",
    unsentDraft: "Unsent draft",
    noArchivedSessions: "No archived sessions.",
    status: "Status",
    statusLive: "Live",
    statusIdle: "Idle",
    statusUnknown: "Unknown",
    statusQueued: "Queued",
    statusRunning: "Running",
    statusDone: "Done",
    statusFailed: "Failed",
    statusInterrupted: "Interrupted",
    statusKilled: "Killed",
    statusTimeout: "Timed out",
    waitingForAnswer: "Waiting for your answer",
    waitingForApproval: "Waiting for approval",
    questionsNeedAnswer: "{count} questions need your answer",
    approvalsNeedApproval: "{count} requests need approval",
    attentionMore: "+{count} more",
    runFailedReason: "Run failed: {reason}",
    childRunFailedReason: "Child session {label} failed: {reason}",
    runErrorTimedOut: "Timed out",
    runErrorUnknown: "Unknown error",
    attentionRequired: "Session needs attention",
    openSession: "Open session",
    provider: "Provider",
    lastActive: "Last active {time}",
    activeRun: "Active run",
    subagentsWorking: "Subagents working",
    showChildSessions: "Show {count} child sessions for {session}",
    hideChildSessions: "Hide {count} child sessions for {session}",
    childSessions: "Child sessions",
    showMoreChildren: "Show {count} more",
    archived: "Archived",
    unread: "Unread",
    automationAttached: "Automation attached",
    incognito: "Incognito session",
    incognitoLabel: "Incognito",
    incognitoDescription:
      "Incognito session. History expires 24 hours after creation or when the Gateway restarts, whichever comes first.",
    incognitoLimits:
      "Your model provider still processes messages. Tools, plugins, and uploads may save data.",
    cloudWorkerPlacement: "Placement: {state}",
    placementWorkspaceConflict: "{placement} · 1 workspace conflict",
    placementWorkspaceConflicts: "{placement} · {count} workspace conflicts",
    cloudWorkerDiskWarning: "Cloud session disk space is low",
    cloudWorkerDiskCritical: "Cloud session disk space is critically low",
    cloudWorkerDescendantConflict: "Cloud worker child: 1 workspace conflict",
    cloudWorkerDescendantConflicts: "Cloud worker children: {count} workspace conflicts",
    sessionColor: "Session color: {color}",
    colors: {
      red: "Red",
      blue: "Blue",
      green: "Green",
      yellow: "Yellow",
      purple: "Purple",
      orange: "Orange",
      pink: "Pink",
      cyan: "Cyan",
    },
    pinSession: "Pin session",
    unpinSession: "Unpin session",
    forkedSession: "Forked session",
    archiveSession: "Archive session",
    restoreSession: "Restore session",
    deleteSessionStale: 'Gateway connection replaced before "{session}" was deleted. Try again.',
    deleteSessionsStale:
      "Gateway connection replaced before {count} sessions were deleted. Try again.",
    groupMenu: "Group options for {group}",
    groupOptions: "Group options",
    newSessionInGroup: "New session in {group}",
    groupDefaultsStale: "Gateway connection replaced before the defaults were saved. Try again.",
    moveToTopLevel: "Move to top level",
  },
  agents: {
    noAgents: "No agents",
    createdBy: {},
    defaults: {},
    copyId: {},
    default: "Default",
    setDefault: {},
    ...agentEn.pinning,
    selectTitle: {},
    selectSubtitle: {},
    tabs: {},
    context: {},
    identity: {},
    overview: {
      title: {},
      subtitle: {},
      selectedSkills: "{count} selected",
      allSkills: "all skills",
      unsavedConfig: {},
      modelSelection: {},
      primaryModel: {},
      primaryModelDefault: {},
      notSet: {},
      inheritDefault: {},
      inheritDefaultModel: {},
      fallbacks: {},
      addFallback: {},
    },
    toolCatalog: {},
    skillsPanel: {},
    channels: {},
    cronPanel: {},
    files: {},
  },
  debug: {
    lanes: {},
    overlay: {
      title: "System busyness",
    },
  },
  configForm: {
    hideValue: "Hide value",
    revealValue: "Reveal value",
    defaultValue: "Default: {value}",
    sections: {},
  },
  // Historical namespace from the pre-restructure "quick settings" page; its
  // keys now serve Models, Privacy & Security, Appearance, and Profile.
  // Renaming would force retranslation of every key, so the name stays.
  quickSettings: {
    appearance: {
      lobsterVisits: "Lobster visits",
    },
    personal: {
      browserOnly: "Stored in this browser only.",
    },
  },
  configPage: {},
  configView: {
    adminRequired: "Configuration changes require operator.admin access.",
    categories: {},
    sections: {},
    themes: {},
    textSizes: {},
    notifications: {},
    appearance: {},
    chatPrefs: {},
    sidebarPrefs: {},
    sessionObserver: {},
    connection: {},
    fileOpenedOnGateway: "Configuration file opened on Gateway host.",
    recoveryNotRestored:
      "Settings could not be restored. Your draft is kept. Check {path} before saving again.",
    recoveryUnknown:
      "Settings restoration could not be confirmed. Your draft is kept. Check {path} before saving again.",
    recoveryBackup: "Inspect the recovery backup at {path}.",
    discardUnconfirmed:
      "The last save could not be confirmed. Your draft is kept. Reload configuration before discarding this setting.",
    writeGatewayChanged:
      "This unsettled change belongs to a different Gateway. Reconnect to that Gateway to retry, or discard the draft.",
    writeUnconfirmed:
      "The last configuration change could not be confirmed. Your draft is kept. Retry before changing other settings.",
    reloadBlocked: "Finish saving or discard pending config changes before reloading.",
    rawDraftBlocksApply: "Save or discard edits in the Raw editor before applying changes.",
    rawDraftBlocksFormEdit:
      "Unsaved raw config edits could not be parsed; resolve them in the Raw editor before changing settings.",
    rawDraftUnverified:
      "Cannot verify the raw draft against the saved configuration; reload and retry.",
  },
  execApproval: {
    scope: {
      standingGrant:
        'Always allow runs this exact command for "{automation}" without asking, until revoked (revocable)',
      standingGrantDays:
        'Always allow runs this exact command for "{automation}" without asking, for {count} days (revocable)',
      messageSend: "Sends to {count} recipient(s) via {target}",
      payment: "Pays {amount} {currency} to {target}",
      externalPost: "Posts externally to {target}",
    },

    agentPendingOne: "{count} pending approval",
    agentPending: "{count} pending approvals",

    reviewOnly: "Review only. Sign in with approval access to record a decision.",

    labels: {},
  },
  approvalPage: {},
  agentTools: {},
  skillGroups: {},
  skillsPage: {},
  skillStatus: {},
  nav: {
    gateway: {
      sectionLabel: "Gateway",
      menuLabel: "Gateway: {gateway}",
      primaryTag: "primary",
      setPrimary: "Set as primary…",
      openSettings: "Gateway settings",
      connected: "Connected",
      unreachable: "Unreachable",
      unknown: "Unknown status",
    },
    owner: "Owner",
    back: "Back",
    forward: "Forward",
    settings: "Settings",
    askOpenClaw: "Ask OpenClaw",
    askBrand: "Ask {brand}",
    settingsGroupDevice: "This Mac",
    settingsGroupThisComputer: "This computer",
    settingsGroupThisIPhone: "This iPhone",
    settingsGroupThisIPad: "This iPad",
    settingsGroupThisDevice: "This device",
    settingsGroupConnections: "Connections",
    settingsGroupAgents: "Agents & Tools",
    settingsGroupSecurity: "Privacy & Security",
    settingsGroupSystem: "System",
    settingsSearchLabel: "Search settings",
    settingsSearchPlaceholder: "Search settings…",
    settingsSearchNoResults: "No matching settings.",
    settingsSearchClear: "Clear settings search",
    settingsLoadFailed: "Settings navigation could not load.",
    exitSettings: "Back to app",
    expand: "Expand sidebar",
    collapse: "Collapse sidebar",
    resize: "Resize sidebar",
    more: "More",
    home: "Home",
    pages: "Pages",
    pin: "Pin",
    unpin: "Unpin",
    customize: "Edit pinned items",
    customizeReset: "Reset pinned items",
    workboardGroup: "WorkBoard",
  },
  terminal: {
    title: "Terminal",
    toggle: "Toggle terminal",
    open: "Open terminal",
    startCancelled: "Terminal start was cancelled. Try again.",
    unavailable: "The terminal is not available on this gateway.",
  },
  browser: {
    nativeTab: {},
    remoteTab: {},
    stop: {},
    profile: {},
    title: "Browser",
    open: "Open",
    openPanel: "Open browser panel",
    moreActions: "More actions",
    copyUrl: "Copy URL",
    openNewTab: "Open in new tab",
    openWithinOpenClaw: "Open in OpenClaw",
    toggle: "Toggle browser panel",
    close: {},
    resize: {},
    newTab: "New tab",
    closeTab: "Close tab",
    untitledTab: {},
    tweetPost: "Post on X",
    openPost: "Open post",
    back: {},
    forward: {},
    reload: {},
    openExternal: "Open in your browser",
    urlPlaceholder: {},
    dockBottom: {},
    dockRight: {},
    annotate: {},
    inspect: {},
    annotateSend: {},
    annotateUndo: {},
    annotateClear: {},
    annotateDone: {},
    annotateHint: {},
    inspectName: {},
    inspectRole: {},
    inspectFocusable: {},
    loading: {},
    notRunning: {},
    start: {},
    errors: {},
    annotatePrompt: {},
  },
  desktop: {
    title: "Desktop",
    openWindow: "Open desktop in new window",
    unavailable: "Desktop viewing is unavailable for this connection.",
    toggle: "Toggle desktop panel",
    reconnect: "Reconnect",
    connecting: "Connecting to desktop…",
  },
  systems: {},
  routeTitles: {
    modelProviders: "Models",
    notifications: "Notifications",
    advanced: "Advanced",
  },
  tabs: {
    device: "This Mac",
    devicePermissions: "Permissions",
    agentsHome: "Agents",
    agents: "Agents",
    activity: "Activity",
    meetings: "Meetings",
    apps: "Apps",
    portals: "Portals",
    approvals: "Approvals",
    workboard: "Workboard",
    worktrees: "Worktrees",
    channels: "Channels",
    connection: "Gateway",
    sessions: "Sessions",
    systems: "Systems",
    usage: "Usage",
    cron: "Automations",
    skills: "Skills",
    plugins: "Plugins",
    skillWorkshop: "Skill workshop",
    devices: "Devices",
    claws: "Claws",
    cloudWorkers: "Cloud environments",
    chat: "Chat",
    dashboards: "Dashboards",
    custodian: "OpenClaw",
    profile: "Profile",
    communications: "Communications",
    appearance: "Appearance",
    lobsterdex: "Lobsterdex",
    automation: "Automation",
    mcp: "MCP",
    memory: "Memory",
    search: "Search",
    talk: "Talk",
    infrastructure: "Infrastructure",
    labs: "Labs",
    updates: "Updates",
    about: "About",
    aiAgents: "Agent Defaults",
    modelSetup: "Model Setup",
    memoryImport: "Import Memory",
    security: "Privacy & Security",
    secrets: "Secrets",
    debug: "Debug",
    logs: "Logs",
    plugin: "Plugin",
  },
  subtitles: {
    device: "App settings and capabilities on this Mac.",
    devicePermissions: "Manage macOS access, location, and computer presence.",
    agentsHome: "Who is on your team and what they are doing",
    agents: "Workspaces, tools, identities.",
    activity: "Recent sessions across people using this gateway.",
    meetings: "Meeting notes and transcripts across this gateway.",
    apps: "Companion apps for phone, watch, desktop, and browser.",
    portals: "Live previews from agent-run applications.",
    approvals: "Recent exec, plugin, and system-agent approvals.",
    workboard: "Agent work queue and session handoff.",
    worktrees: "Isolated agent task checkouts and recovery snapshots.",
    channels: "Channels and settings.",
    connection: "Gateway endpoint, credentials, and handshake status.",
    sessions: "Active sessions and defaults.",
    systems: "Machines and desktops.",
    usage: "API usage and costs.",
    cron: "Scheduled tasks and recurring agent runs.",
    skills: "Manage your agent skills",
    plugins: "Extend your Claw with tools",
    skillWorkshop: "Skills your agent learned, recent changes, and undo.",
    devices: "Paired devices, pairing approvals, and exec bindings.",
    claws: "Explore and add official Claws.",
    cloudWorkers: "Repository snapshots and machines for cloud sessions.",
    chat: "Gateway chat for quick interventions.",
    dashboards: "Tasks with saved dashboards.",
    custodian: "System setup and care.",
    config: "Legacy settings route; opens Appearance.",
    profile: "Your display name, avatar, and identity on this gateway.",
    communications: "Messages, text-to-speech, and meeting capture settings.",
    appearance: "Theme and UI settings.",
    lobsterdex: "Every lobster palette that has visited this browser.",
    automation: "Commands, hooks, automations, and plugins.",
    mcp: "MCP servers, auth, tools, and diagnostics.",
    memory: "Memory engine, search, and dreaming.",
    search: "Choose how agents search the web and check provider health.",
    talk: "Realtime voice: provider, model, and speaker voice.",
    infrastructure: "Gateway, browser, node host, discovery, and ACP settings.",
    labs: "Experimental agent and tool capabilities.",
    updates: "Release channel, automatic updates, and current update status.",
    about: "Control UI and connected Gateway build identity.",
    aiAgents: "Global agent defaults: skills, tools, and session.",
    modelSetup: "Connect a verified AI model",
    modelProviders: "Default models, behavior, provider access, usage, and cost.",
    memoryImport: "Bring Codex and Claude Code memory into an agent workspace.",
    notifications: "Browser push notifications from your gateway.",
    security: "Gateway auth, exec policy, tool profile, and approvals.",
    advanced: "Every remaining config section, plus the raw file editor.",
    debug: "Snapshots, events, RPC.",
    logs: "Live gateway logs.",
    plugin: "Plugin-provided panel.",
  },
  meetingCapture: {
    title: "Meeting capture",
    description: "Choose which sources can save meeting notes on this Gateway.",
    sources: "Auto-start sources",
  },
  cloudWorkersPage: {},
  portalsPage: {},
  modelSetup: {
    discovery: {},
    missingAuth: "No provider credential is configured for this model. Set it up in Model Setup.",
    commandHint: "Try /models or /help.",
    heading: {},
    intro: {},
    required: {
      title: "No AI provider configured",
      body: "Connect a provider and choose a model to send messages.",
      action: "Connect an AI provider",
    },
    loading: {},
    testing: {},
    retry: {},
    checkAgain: {},
    recovery: {},
    verify: {},
    access: {},
    candidates: {
      title: {},
      recommended: {},
      credentialsReady: {},
      signInNeeded: "Sign-in needed",
      detected: {},
      testAndUse: {},
      retry: {},
      testingButton: {},
    },
    nativeDiscovery: {},
    nativeModels: {},
    empty: {},
    signIn: {},
    prepare: {},
    manual: {},
    success: {},
    utility: {},
    failure: {
      auth: "Authentication failed",
    },
    failureGuidance: {
      auth: "Review the provider credential or sign-in, then retry.",
    },
    errors: {},
    wizard: {},
    waitingForApproval: {},
    providerConnected: {},
  },
  memoryImport: {},
  onboarding: {
    memoryImport: {
      title: "Bring your assistant memory with you",
    },
  },
  assistantPanel: {
    title: "Assistant sidebar",
    home: "Home",
    toggle: "Talk to your Home agent",
    openHome: "Open Home full page",
    close: "Close assistant sidebar",
    resize: "Resize assistant sidebar",
    dockBottom: "Dock assistant sidebar at bottom",
    dockRight: "Dock assistant sidebar at right",

    contextOff: "Work context off",
  },
  custodian: {
    title: {},
    subtitleCaretaker: {},
    exitSetup: {},
    newAgent: "New agent",
    hatchDraft: {},
    placeholder: {},
    sensitivePlaceholder: {},
    sensitiveReply: {},
    cancel: {},
    send: {},
    thinking: {},
    earlier: {},
    requestFailed: {},
    connectionChanged: {},
    sessionRestarted: {},
    unsupportedGateway: {},
    accessRequired: {},
    autoSetup: { thisComputer: "This computer" },
    panel: {},
    history: {},
    nudge: {},
  },
  mcpServers: {},
  mcpPage: {},
  talkPage: {},
  memoryPage: {},
  sessionsPage: {
    hubTablistLabel: "Session sections",
  },
  pluginsPage: {
    installed: "Installed",
    official: "Official",
    install: "Install",
  },
  labsPage: {
    intro:
      "Labs contains experimental capabilities that may change, break, or disappear between releases.",
    sectionTitle: "Experimental features",
    sectionDescription:
      "Changes save without restarting the Gateway. Code Mode and Tool Search apply to future agent runs.",
    documentation: "Documentation",
    restartRequired: "Gateway restart required.",
    saveErrorTitle: "Could not update feature",
    saveFailed: "The feature setting could not be saved.",
    decisionAssistance: {},
    codeMode: {},

    swarm: {
      title: "Swarm",

      defaultPhase: "Unphased",
    },
    toolSearch: {},

    customPluginUi: {},

    hostDesktop: {},
    workerDesktop: {},
  },
  aboutPage: {
    artifactDetails: "Control UI build details",
    commit: "Commit",
    built: "Built",
    unavailable: "Unavailable",
    copyCommit: "Copy full commit hash",
    copiedCommit: "Commit hash copied",
    gateway: "Gateway",
  },
  appsPage: {},
  presence: {
    sharedOwner: {
      name: "Shared owner",
      named: "{name} · Shared owner",
      hint: "Connected with the Gateway token or over a tunnel, not a personal sign-in.",
    },
    rosterTitle: "Online",
    usersTitle: "Users",
    allUsers: "All users",
    directoryFailed: "Could not load all users. Retry",
    filters: {
      label: "Filter & sort people",
      noMatches: "No people match this filter",
      presence: "Active people first",
      reset: "Reset to defaults",
      running: "Running sessions",
      total: "Total sessions",
      name: "Name",
    },
    active: "Active",
    onlineActive: "Online · Active",
    onlineIdle: "Online · Idle",
    idle: "Idle",
    offline: "Offline",
    sessions: {
      openCount: "{count}\u00a0open",
      runningCount: "{count}\u00a0running",
      openHint:
        "Owned, unarchived conversations you can access across agents. Excludes hidden subagents, automation, and system sessions.",
      runningHint: "Open sessions actively executing an agent turn. Queued work is not running.",
      counts: "{open} open sessions, {running} running",
      unavailable: "Session counts unavailable",
      retry: "Counts may be out of date. Retry",
    },
    card: {
      details: "Details for {name}",
      loadFailed: "Could not open details. Try again, or open this person’s Activity page.",
      ariaLabel: "Activity for {name}",
      person: "Person",
      onlineFor: "Online for",
      where: "Where",
      reportedTimeZone: "Reported time zone: {zone}",
      lastActivity: "Last interaction",
      notObserved: "Activity unavailable",
      viewingNow: "Viewing now",
      recentSessions: "Recent sessions",
      noVisibleSessions: "No visible sessions being viewed.",
      noRecentSessions: "No recent visible sessions.",
      sessionUpdated: "Session updated",
      ago: "ago",
      viewActivity: "View activity",
      web: "Web app",
      cli: "Command line",
      terminal: "Terminal",
      app: "App",
    },
  },
  activityFeed: {
    showing: "Showing {shown} of {total}",
    viewingNow: "Viewing now",
  },
  githubPublication: {
    newAction: "Choose a new publication",
    capacity:
      'Too many publications are awaiting review. Finish an existing publication, then select "{newAction}" to make room. Existing retries remain available.',
  },
  githubConnections: {
    title: "GitHub connections",
    mine: "My GitHub",
    system: "System GitHub",
    forMe: "For me",
    forSystem: "For the system",
  },
  profilePage: {
    personalInstructions: {
      title: "Personal instructions",
      description:
        "Tell this agent about you and how you like to work. This edits only your personal USER.md, not the shared workspace file.",
    },
    offline: "Connect to the gateway to meet your agent.",
    access: {},
    usageStatistics: "Usage statistics",
    usageStatisticsDescription: "View activity, costs, and usage trends.",
    identity: {
      title: "Identity",
      menuLabel: "Identity menu",
      menuButtonLabel: "Identity and app menu for {name}",
      description: "Your profile on this gateway.",
      avatar: "Avatar",
      chooseAvatar: "Choose image",
      displayName: "Display name",
      linkedEmails: "Linked emails",
    },
    modelAccounts: {},
  },
  skillWorkshop: {},
  // Chat swarm summaries render before the lazy Activity catalog loads.
  // Keep their shared label in startup English; Activity replaces the full namespace on entry.
  activity: {
    status: {
      done: "Done",
    },
  },
  gatewayLogs: {},
  pluginTabs: {
    unavailableTitle: "Plugin panel unavailable",
    unavailableSubtitle:
      "The plugin that owns this tab is not active on the connected gateway, or it did not provide a panel.",
  },
  logbook: {},
  board: {
    announcement: {},
    widget: {
      resizeHandle: "Resize {title}",
      menuLabel: "Widget options",
      moveToTab: "Move to tab",
      noOtherTabs: "No other tabs",
      resize: "Resize",
      autoHeight: "Auto height",
      remove: "Delete",
    },
  },
  connection: {
    browserSignIn: {
      title: "Sign in to continue loading content",
      description:
        "Your website sign-in has expired. Images and files cannot load until you sign in again. Your conversation and draft will stay open.",
      action: "Sign in",
      dismiss: "Not now",
      returnHint: {},
      checkAgain: {},
      checking: {},
      stillRequired: {},
      unavailable: {},
    },
    connecting: "Connecting…",
    starting: "Starting…",
    restoring: "Restoring…",
    "reload-required": "Refresh required",
    offline: "Disconnected",
    reconnecting: "Reconnecting…",
    interruptedRetrying:
      "Connection to the Gateway was interrupted. Reconnecting automatically. (WebSocket {code})",
    interrupted:
      "Connection to the Gateway was interrupted. Check your connection and try again. (WebSocket {code})",
    restarting: "Restarting…",
    suspending: "Suspending…",
    suspended: "Suspended",
    retryNow: "Retry now",
    queued: "{count} queued",
    offlineChangesDiscarded: "Offline changes discarded: {count}",
    offlineChangesReloadBlocked:
      "Offline changes are waiting to reconnect. Reloading would discard them.",
    sessionMoveRefreshFailed: "The session move was saved, but refreshing the list failed: {error}",
    sessionMoveUncertain:
      "The session move could not be confirmed. Refresh and check its group before retrying. {error}",
    sessionOperationCompletedPreviousConnection:
      "The session operation completed on the previous connection. Check the current session list before continuing.",
    sessionOperationCompletedPreviousConnectionWithRefreshError:
      "The session operation completed on the previous connection, but refreshing the current session list failed: {error}",
    scopeUpgrade: {},
    // Settings → Gateway copy lives in the lazy en-settings catalog; the anchor keeps its merge target.
    access: {},
    switchGateway: {},
    help: {
      title: {},
      step1: {},
      step2: {},
      step3: {},
      docsLink: {},
      copyCommand: "Copy command",
      copyCommandAria: "Copy command: {command}",
    },
  },
  // The Inbox loader renders before its diagnostics catalog loads.
  attention: {
    issues: "Inbox",
  },
  standingGrants: {},
  approvalHistory: {},
  commandPalette: {},
  palette: {
    placeholder: "Search or start a task…",
    attachmentPrompt: "What would you like to do with these files?",
    categories: { navigation: "Navigation" },
  },
  dreaming: {},
  modelProviders: {},
  searchPage: {},
  usage: {
    common: {
      emptyValue: "—",
      unknown: "unknown",
      atLeast: "≥ {value}",
      approx: "≈ {value}",
    },
    loading: {
      title: "Usage Overview",
      badge: "Loading",
    },
    metrics: {
      tokens: "Tokens",
      cost: "Cost",
      session: "session",
      sessions: "sessions",
    },
    heatmap: {
      title: "Token Activity",
      subtitle: "Daily token intensity for the selected range, up to one year.",
      cellTokens: "{tokens} tokens",
      less: "Less",
      more: "More",
    },
    providerUsage: {
      title: "Provider plans & billing",
      subtitle: "Live plan, quota, balance, and budget data reported by configured providers.",
      stalled: "Provider usage did not finish loading. Refresh to retry.",
      unavailable: "Provider usage is unavailable; the last request failed. Refresh to retry.",
      balance: "Balance",
      spend: "Usage",
      budget: "Budget",
      today: "Today",
      last7Days: "7 days",
      lastDays: "{count} days",
      dailyCost: "Daily provider cost",
      requests: "{count} requests",
      inputTokens: "{count} input",
      cacheTokens: "{count} cache",
      outputTokens: "{count} output",
      topModels: "Top models",
      costCategories: "Cost categories",
      remaining: "{percent}% left",
      resets: "Resets {date}",
      exhausted: "{label} is used up.",
      checkFailed: "Check failed",
      exhaustedUntil: "{label} is used up until {date}.",
    },
    presets: {},
    scope: {},
    filters: {},
    query: {},
    export: {},
    cacheStatus: {},
    empty: {},
    daily: {},
    costWindows: {},
    breakdown: {
      output: "Output",
      input: "Input",
      cacheWrite: "Cache Write",
      cacheRead: "Cache Read",
      total: "Total",
      tokensByType: "Tokens by Type",
      costByType: "Cost by Type",
    },
    overview: {
      title: "Usage Overview",
    },
    sessions: {},
    // Sidebar collapse stays eager; Usage registers the remaining detail copy.
    details: {
      noUsageData: {},
      duration: {},
      modelMix: {},
      filtered: {},
      close: {},
      noTimeline: {},
      loadFailed: {},
      noDataInRange: {},
      usageOverTime: {},
      rangeStart: {},
      rangeEnd: {},
      reset: {},
      perTurn: {},
      cumulative: {},
      turnRange: {},
      assistantOutputTokens: {},
      userToolInputTokens: {},
      tokensWrittenToCache: {},
      tokensReadFromCache: {},
      noContextData: {},
      contextOutOfDate: {},
      systemPromptBreakdown: {},
      collapse: "Collapse",
      collapseAll: {},
      expandAll: {},
      baseContextPerMessage: {},
      system: {},
      systemShort: {},
      skills: {},
      tools: {},
      files: {},
      ofInput: {},
      of: {},
      timelineFiltered: {},
      loadedIntervalMessages: {},
      conversation: {},
      noMessages: {},
      tool: {},
      toolResult: {},
      hasTools: {},
      searchConversation: {},
      filterByRole: {},
      filterByTool: {},
      you: {},
      noMessagesMatch: {},
    },
    mosaic: {},
  },
  // Login copy lives in the lazy en-login catalog; the anchor keeps its merge target.
  login: {},
  chat: {
    sessionAutomation: {},
    activityPills: {},
    mobileDetails: {
      people: "People",
      outputs: "Outputs",
      generatedFiles: "Generated files",
    },
    sessionDetails: {
      automations: "Automations",
      progressOptions: "Task progress options",
      automationError: "Couldn't load automations.",
      automationUnavailable: "Automations unavailable for this session.",
      automationLoading: "Loading automations…",
      automationEmpty: "No automations for this session",
      automationMore: "Load more automations",
      automationAttention: "Needs attention",
      automationPaused: "Paused",
      automationEnabled: "Enabled",
    },
    agentDatabaseWarming: "This agent is still starting. Retry in a moment.",
    historyRequestTimedOut: "Chat history request timed out. Retry to load the conversation.",
    clawhub: {},
    modelAccounts: {
      section: "Account",
      automatic: "Automatic (new-chat default)",
      manage: "Manage saved accounts…",
    },
    mentions: {},
    cloudWorkerFailed: "Runner failed: {error}",
    errorDetails: "Error details",
    errorReplySummary: "Couldn't finish this reply. Check the conversation before trying again.",
    errorReplyTitle: "Couldn’t finish this reply",
    historyUnavailableTitle: "Couldn’t load this conversation",
    historyUnavailableBody: "Try again to load its messages.",
    recovery: {
      retrying: "Retrying…",
      retryingIn: "Retrying in {seconds}s",
      tryingFallback: "Trying fallback model…",
      failedTitle: "Unable to finish this reply",
      failedHelp: "Automatic recovery has stopped. Check any completed work before trying again.",
      tryAgain: "Try again",
      continuePrompt:
        "Continue from where you stopped. Check which actions already completed before retrying anything.",
    },
    errorBusySummary: "OpenClaw is busy. Check status before trying again.",
    errorSignInSummary: "Couldn't sign in to the AI service. Sign in again under Models.",
    errorStartSummary: "Couldn't start this conversation. Open Settings → Logs for details.",
    checkStatus: "Check status",
    details: "Details",
    usageLimit: {},
    copyError: "Copy error",
    providerAccessRemoved:
      "This reply stopped because the provider was signed out. Sign in again or choose another model.",
    providerReview: {},
    providerPolicy: {},
    diskSpace: {},
    workerRuntimeInstall: {},
    sendErrors: {},
    waitingForApproval: "Waiting for approval…",
    waitingOnSubagents: "Waiting on subagents",
    waitingForMessage: "Waiting for a message",
    turnElapsed: "Total time since your message, including subagent waits",
    waitingOnSubagent: "Waiting on {name}",
    subagentsRunning: "{count} subagents running",
    subagentsRunningOne: "1 subagent running",
    startupStatus: {
      preparingWorkspace: "Preparing workspace…",
      namingWorktree: "Naming worktree…",
      updatingRepository: "Updating repository…",
      creatingWorktree: "Creating worktree…",
      runningSetup: "Running setup…",
      provisioningEnvironment: "Provisioning environment…",
      startingFromSnapshot: "Starting from snapshot…",
      preparingCloudEnvironment: "Preparing cloud environment…",
      savingSnapshot: "Saving snapshot…",
      preparingContext: "Preparing this turn…",
      waitingForTurn: "Waiting for turn to start…",
      memoryFlushing: "Saving conversation memory…",
      startingModel: "Waiting for a response",
      waitingForLocalModel: "Waiting for the local model to respond",
      waitingForModelSlot: "Waiting for a free model slot",
      waitingForState: "Temporarily busy—retrying…",
    },
    archivedSessionDisabled: "This session is archived. Unarchive it to continue the conversation.",
    subagentViewOnly: "View-only subagent",
    subagentSessionDisabled: "Continue in {parent}.",
    processesPanel: { title: "Processes", refresh: "Refresh processes" },
    subagentsPanel: {},
    parentSession: "the parent session",
    openParentSession: "Open parent session",
    parentSessionUnavailable: "Parent session information is unavailable.",
    sessionRoute: {},
    commandResults: {
      startingNewThread: "Starting new session...",
      resettingThread: "Resetting session...",
      stoppingCurrentRun: "Stopping current run...",
      chatHistoryCleared: "Chat history cleared.",
      emptyExport: "There are no messages to export yet.",
      exportPathUnsupported:
        "Control UI exports Markdown through your browser. Run /export without a file path.",
      unknownCommand: "Unknown command: `{command}`",
      options: "Options: {options}.",
      sessionUnavailable: "Session capability is unavailable",
      help: {},
      compaction: {},
      model: {},
      thinking: {},
      verbose: {},
      fast: {
        autoValue: "auto ({seconds} sec)",
        on: "on",
        off: "off",
        sourceSession: " (session)",
        sourceAgent: " (default: agent)",
        sourceModel: " (default: model)",
        sourceDefault: " (default)",
        current: "Current fast mode: {value}",
      },
      usage: {},
      agents: {},
      steer: {},
      redirect: {},
    },
    sessionSharing: {
      draft: "Draft",
    },
    reactions: {},
    sessionSuggestions: {
      state: {},
    },
    sessionHeader: {},
    board: {},
    catalog: {},
    taskSuggestions: {},
    pullRequests: {
      open: "Open",
      draft: "Draft",
      merged: "Merged",
      closed: "Closed",
    },
    usageRemaining: "Usage Remaining",
    view: {},

    sendShortcutModifierEnter: "⌘/Ctrl+Enter",

    followUpModeSteer: "Steer into the active run",

    catalogOutputTruncated: "[Output truncated]",
    onboardingDisabled: "Disabled during setup",
    commandPaletteTitle: "Search or jump to… (⌘K)",
    openCommandPalette: "Command palette",

    actions: {
      copyAsMarkdown: "Copy as markdown",
      dismissError: "Dismiss error",
      exitFocusMode: "Exit focus mode",
      scrollToLatest: "Scroll to latest",
    },
    markdown: {
      truncated: "… truncated ({total} chars, showing first {shown}).",
    },
    mermaid: {},
    codeBlock: {},
    workspaceConflict: {},
    compaction: {
      label: "Compacted history",
      savedTokens: "saved {count} tokens",
    },
    sessionReset: {
      label: "Session reset",
      description: "The earlier conversation was cleared.",
    },
    outboxRecoveryReviewTitle: {},
    outboxRecoveryConfirm: {},
    outboxRecoveryRestore: {},
    outboxRecoveryConflict: {},
    outboxRecoveryStorageFailed: {},
    outboxRecoveryFull: {},
    outboxRecoveryDraft: {},
    outboxRecoveryQueued: {},
    outboxRecoverySource: {},
    outboxRecoveryUpdated: {},
    outboxRecoveryGoal: {},
    outboxRecoveryReply: {},
    outboxRecoveryAttachments: {},
    outboxRecoveryUnconfirmedLabel: {},
    outboxRecoveryUnconfirmed: {},
    outboxRecoveryAttachmentMissing: {},
    outboxRecoveryDelete: {},
    outboxRecoveryDeleteTitle: {},
    outboxRecoveryDeleteConfirm: {},
    outboxRecoveryDeleteConflict: {},
    privateDraftReload: {
      blocked: "An unsent Incognito draft is keeping this tab open. Review it before refreshing.",
      review: "Review private draft",
      changed:
        "The draft changed while you were reviewing it. It has not been discarded; review the current draft before refreshing.",
      unavailable:
        "The private draft could not be opened. It remains in this tab; try Review private draft again.",
    },
    incognitoExpiredTitle: "Incognito session expired",
    incognitoExpiredBody:
      "Incognito sessions last for 24 hours or until the Gateway restarts. Your unsent input stays in this tab.",
    newIncognitoSession: "New Incognito session",
    restartRecoveryTitle: "This task was interrupted by a restart.",
    restartRecoveryDisabled: "Your transcript is safe. Resume to continue in this session.",
    restartRecoveryNewSession:
      "This provider cannot safely resume tool work here. Your transcript can continue in a new session.",
    resumeSession: "Resume",
    resumeInNewSession: "Resume in new session",
    resumingSession: "Resuming…",
    systemNotice: {
      guardian: {},
      restartRecovery: {},
      automationRecovery: {},
      gatewayRestarted: {},
      cliHarnessContext: {},
      claudeCliTaskNotification: {},
      pluginSteering: {},
    },
    skillLearned: {},
    progressLabels: {},
    turnRecap: {
      doneIn: "Done in {duration}",
      tokens: "{count} output tokens",
      tokensOne: "1 output token",
    },
    commands: {},
    skills: {
      menu: "Skill references",
      label: "Skills",
      loading: "Loading skills…",
    },
    splitView: {
      chooseConversation: "Choose a conversation",
      missingOwner:
        "Select this pane, then choose Home or a conversation in the sidebar to restore it.",
      open: "Open split view",
      splitRight: "Split right",
      splitDown: "Split down",
      closePane: "Close pane",
      panePosition: "Column {column}, row {row} ({pane})",
      dropSplit: "Split",
      dropOpenHere: "Open here",
    },
    sidebar: {
      mySessions: "My sessions",

      threads: "Sessions",
      pinned: "Pinned",
      otherSessions: "Other",
      groups: "Groups",
      coding: "Coding",
      catalogViewOptions: "View options",
      reorderItem: "Reorder {item}",
      moveUp: "Move up",
      moveDown: "Move down",
      hideFromSidebar: "Hide from sidebar",
      sectionHidden: "{section} hidden.",
      sectionHiddenRecovery: "Show it again in Settings > Appearance > Sidebar.",

      catalogGroupByProject: "Project",
      catalogGroupByPerson: "Person",
      openSessionMenu: "Open session menu",
      sortBy: "Sort by",
      sortCreated: "Created",
      menuFilters: "Filters",
      menuDisplay: "Display",
      hideEmpty: "Hide empty",
      activeFilterCount: "Active filters: {count}",
      sortSessions: "Filter & sort",
      sessionSources: "Session sources",
      showAllSessions: "Show all sessions",
      noActiveSessionsForFilter: "No active sessions match this filter",
      sortUpdated: "Last updated",
      sessionMenu: "Actions for {session}",
      sessionMenuMany: "Actions for {count} sessions",
      catalogDiscoveryHelp:
        "{error}. Configure automatic session discovery in Settings > Appearance > Session sources.",
      catalogPaginationFailed: "Session catalog returned a repeated page cursor",
      catalogPageMissingHost: "Session catalog page did not include the requested host",
    },
    welcome: { suggestions: { whatCanYouDo: "What can you do?" } },
    runControls: {
      newSession: "New session",
      newSessionWorktree: "New session in worktree",
      exportChat: "Export chat",
      queue: "Queue",
      queueMessage: "Queue message",
      stop: "Stop",
      stopWithShortcut: "Stop (Esc)",
      stopGenerating: "Stop generating",
      send: "Send",
      sendMessage: "Send message",
    },
    queue: {},
    goals: {},
    asyncQuestions: {},
    questions: {
      showSecret: "Show secret",
      hideSecret: "Hide secret",
      answer: "Answer",
      disconnected: "Not connected. Try again after reconnecting.",
    },
    imageLightbox: {},
    externalImage: { notLoaded: "External image not loaded", open: "Open image" },
    messages: {
      copySelection: "Copy",
      replyingTo: "Replying to {name}",
      message: "message",
      showLess: "Show less",
      showMore: "Show more",
      tooLargeToDisplay: "This message is too large to display here.",
      unattributedSender: "Message",
      toolSender: "Tool",
      errorSender: "Error",
    },
    mediaPlayer: {},
    youtube: {},
    modelControls: {},
    nativeRuntimeRecovery: {},
    permissionControls: {},
    rail: {},
    detailPanel: {},
    sidebarColumns: {
      close: "Close {panel}",
    },
    sidePanel: {
      label: "Side panel",
      quickAccess: "Quick access",
      explorePanels: "Explore panels",
      addTab: "Add side panel tab",
      closeNewTab: "Close New tab",
      closeAll: "Close all",
      closeAllTabs: "Close all tabs",
      closeOtherTabs: "Close other tabs",
      closeFileChanges: "Save changes to {file} before closing?",
      reviewFileChanges: "Open the file to review its unsaved changes before closing.",
      expand: "Focus",
      expandPanel: "Expand {panel}",
      restore: "Restore split",
      useViewAsDefault: "Use current view as default",
      currentViewIsDefault: "This is the default view",
      defaultViewDescription:
        "Used when anyone opens this dashboard. Personal layout choices still apply.",
      savingDefault: "Saving default…",
      defaultSaved: "Dashboard default saved for future opens.",
      defaultSaveFailed:
        "Could not save the dashboard default. Check the connection and try again.",
      defaultSaveError: "Could not save the dashboard default: {error}",
      swap: "Swap {main} and {side}",
      layout: "Layout",
      panelPosition: "Panel position",
      dockLeft: "Move side panel left",
      dockRight: "Move side panel right",
      dockBottom: "Move side panel below",
      positionLeft: "Left",
      positionRight: "Right",
      positionBelow: "Below",
      conversation: "Chat",
      showChat: "Show this conversation",
      hideChat: "Hide this conversation",
      conversationEmpty: "The conversation for this task.",
      minimize: "Minimize side panel",
      resize: "Resize side panel",
      review: "Review",
      reviewEmpty: "Open a change, file, image, or tool result to review it here.",
      terminal: "Terminal",
      terminalEmpty: "Open a shell for this session's workspace.",
      browser: "Browser",
      browserEmpty: "A shared browser for you and the agent.",
      browserUnavailableReason: {
        permission: "You need operator.admin to use Browser.",
        disconnected: "Disconnected.",
        unavailable: "Browser unavailable.",
      },
      files: "Files",
      filesEmpty: "Browse files, artifacts, and changes from this session.",
      companion: "Side chat",
      companionEmpty: "Ask a focused question about this session.",
      processes: "Processes",
      processesEmpty: "Inspect background commands and their output for this conversation.",
      subagents: "Subagents",
      subagentsEmpty: "Follow delegated work from this conversation.",
      desktop: "Desktop",
      desktopEmpty: "Connect to an available remote desktop.",
      portal: "Portal",
      portalEmpty: "Preview a web application running for this task.",
      discussion: "Discussion",
      discussionEmpty: "Open the shared discussion for this session.",
      dashboard: "Dashboard",
      dashboardOptions: "Dashboard options",
      dashboardSize: "Size",
      dashboardEmpty: "This task does not have a dashboard yet.",
    },
    thread: {},
    pendingInputs: {
      agentUpdate: {},
    },
    pairingQrExpired: {
      title: "Pairing QR expired",
      reason: "Run /pair qr again to generate a fresh setup code.",
      badge: "Expired",
    },
    composer: {},
    attachments: {
      previewUnavailable: "Preview unavailable",
    },
    voice: {},
    selectors: {
      loadMoreSessions: "Show more",
      loadMoreRosterSessions: "Load more sessions",
      model: "Chat model",
      modelSection: "Model",
      modelLocked: "Locked",
      modelLockedLabel: "Model selection controlled for this session",
      lockedSessionModel: "Session model",
      thinkingLevel: "Chat thinking level",
    },
    permissions: {},
    toolCards: {
      activity: {},
      review: {},
      verbs: {},
    },
    workRun: {
      workedFor: "Worked for {duration}",
      worked: "Worked",
      toolCallsOne: "1 tool call",
      toolCallsMany: "{count} tool calls",
    },
    sessionDiff: {
      title: "Changes",
      show: "Show session changes",
    },
    sessionDiscussion: {},
    workspaceFiles: {
      copyPath: "Copy path",
    },
  },

  languages: {},
  // Navigation and in-chat secret requests render before the Secrets page loads.
  secretsStore: {
    allowedHosts: "Allowed hosts",
    allowedHostsPlaceholder: "api.example.com",
    protectedSecret: "Protected secret",
    agentReadable: "Agent-readable environment",
    hint: "Choose protected, write-only secrets or intentionally agent-readable Gateway environment values.",
  },
  cron: {
    adminRequired: "Browsing only. Automation changes require operator.admin access.",
    tabs: {},
    list: {},
    suggestions: {},
    stats: {},
    detail: {},
    actions: {},
    // Shared cron actions report outcomes before the automation page loads.
    runNotStarted: {
      notDue: "This automation is not due yet.",
      alreadyRunning: "This automation is already running.",
      recoveryPending: "Scheduler recovery is still in progress.",
      invalidSpec: "This automation has an invalid schedule or payload.",
      stopped: "The scheduler is stopped.",
      unknown: "This automation could not be started.",
    },
    jobs: {},
    runs: {},
    form: {},
    jobState: {},
    runEntry: {},
    errors: {
      nameRequired: "Name is required.",
      activeHoursTime: "Enter HH:MM (24:00 is allowed only for the end).",
      activeHoursTimezone: "Enter a valid IANA timezone, local, or user.",
      scheduleAtInvalid: "Enter a valid date/time.",
      everyAmountInvalid: "Interval must be greater than 0.",
      triggerIntervalTooShort:
        "Condition-triggered automations must run at least every 30 seconds.",
      cronExprRequired: "Cron expression is required.",
      staggerAmountInvalid: "Stagger must be greater than 0.",
      triggerScriptRequired: "Trigger script is required when the condition trigger is enabled.",
      triggerScriptPayloadUnsupported:
        "Script payloads cannot use condition triggers because both own the same saved state.",
      triggerScheduleUnsupported:
        "Condition triggers require an interval, cron, or stream schedule.",
      systemTextRequired: "System text is required.",
      agentMessageRequired: "Agent message is required.",
      timeoutInvalid: "If set, timeout must be 0 or greater (0 disables this timeout).",
      deliveryModeRequired:
        "Choose a delivery mode explicitly, or run openclaw doctor --fix to repair legacy settings.",
      webhookUrlRequired: "Webhook URL is required.",
      webhookUrlInvalid: "Webhook URL must be a valid http(s):// URL without embedded credentials.",
      invalidRunTime: "Invalid run time.",
      invalidIntervalAmount: "Invalid interval amount.",
      cronExprRequiredShort: "Cron expression required.",
      invalidStaggerAmount: "Invalid stagger amount.",
      systemEventTextRequired: "System event text required.",
      agentMessageRequiredShort: "Agent message required.",
      nameRequiredShort: "Name required.",
    },
  },

  linkReader: {
    loadingPreview: "Loading preview…",
    title: "Link reader",
    urlPlaceholder: "Supported link URL",
  },
} satisfies TranslationMap;

export const en: typeof startupEnglish & EnglishCatalog = startupEnglish;
