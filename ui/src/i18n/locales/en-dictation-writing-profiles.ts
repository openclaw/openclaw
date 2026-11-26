import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enDictationWritingProfiles = {
  talkPage: {
    writingProfiles: {
      title: "Dictation writing profiles",
      description:
        "Save your preferred dictation handling. Profiles are off until you enable them.",
      enabled: "Enable writing profiles",
      default: "Global default",
      noDefault: "No default — preserve the transcript",
      choose: "Profile to edit",
      empty: "No writing profiles saved.",
      add: "Create profile",
      newLabel: "Untitled profile",
      remove: "Delete this profile",
      label: "Profile name",
      profileEnabled: "Enable this profile",
      priority: "Selector priority",
      priorityHelp:
        "Higher numbers win within the same selector scope. Equal-priority conflicts must be resolved before saving.",
      handling: "Transcript handling",
      locale: "Preferred language tag",
      localeHelp:
        "Optional BCP 47 tag, such as en-US. Leave empty to preserve the current transcription language. Overrides are unavailable in this client.",
      punctuation: "Punctuation",
      capitalization: "Capitalization",
      fillers: "Fillers",
      corrections: "Spoken corrections",
      structure: "Structure",
      register: "Register suggestion",
      literal: "Literal",
      prose: "Prose",
      preserve: "Preserve",
      automatic: "Automatic punctuation",
      sentence: "Sentence capitalization",
      conservative: "Conservative filler removal",
      explicit: "Explicit spoken corrections",
      paragraphs: "Paragraphs",
      lists: "Lists",
      unchanged: "Unchanged",
      chat: "Chat",
      email: "Email",
      capabilities:
        "This browser supports manual selection and a global default. External application and browser-origin matching are unavailable. Saved selectors remain inactive here; no window text, tab list, history, or clipboard is collected.",
      processing:
        "Requested punctuation, capitalization, filler removal, corrections, structure, and language changes are saved but unavailable in this client. Dictation preserves the original transcript. Register suggestions are advisory; they do not rewrite text.",
      selectors: "Application and origin selectors",
      selectorsHelp:
        "Save a stable application identity and, optionally, one exact HTTP(S) origin. Origin rules need both the application identity and the origin. Native context permission is a separate opt-in when a supported client is available.",
      selectorNumber: "Selector {number}",
      selectorKind: "Match",
      application: "Application",
      applicationOrigin: "Application and exact origin",
      platform: "Identity type",
      macos: "macOS bundle ID",
      windows: "Windows AppUserModelID",
      linux: "Linux desktop ID",
      applicationId: "Stable application ID",
      origin: "Exact origin",
      originHelp:
        "Use only scheme, host, and optional port. Paths, queries, fragments, credentials, and wildcards are not accepted.",
      addSelector: "Add selector",
      removeSelector: "Remove selector {number}",
      save: "Save profiles",
      refresh: "Refresh saved version",
      refreshHelp:
        "Refreshing discards unsaved edits. Export the draft first if you want to keep it.",
      transfer: "Import and export",
      transferHelp:
        "Exports include profile names, application IDs, origins, and policy settings. Validated profiles contain no audio or transcripts. Unsupported versions are exported unchanged and may contain unrecognized data. Imports replace the complete saved catalog in one operation, with the feature and every imported profile disabled. Review before enabling or sharing.",
      importLabel: "Writing profiles JSON",
      import: "Import with all profiles disabled",
      importBlocked: "Save or refresh your unsaved edits before importing.",
      export: "Export saved profiles",
      exportDraft: "Export unsaved draft",
      exportQuarantined: "Export quarantined import",
      quarantine:
        "This import uses an unsupported schema version. It has been kept for export only and has not changed your saved settings.",
      issue: "{path}: {code}",
      statuses: {
        loading: "Loading saved writing profiles…",
        ready: "Saved settings loaded. Changes apply only after you save.",
        edited: "Unsaved changes. Current dictation continues using the saved settings.",
        saving: "Saving writing profiles…",
        saved: "Writing profiles saved. New recordings use these settings.",
        imported:
          "Profiles imported with all activation disabled. Review the settings before enabling them.",
        conflict:
          "Another client changed these settings. Your unsaved edits are still here. Export your draft, then refresh the saved version before applying your changes again.",
        invalid:
          "These settings could not be saved. Review the validation details below; your saved settings have not changed.",
        "read-only":
          "The stored catalog is invalid or uses an unsupported schema version. It is read-only and inactive. You can export it without changing it.",
        "no-durable-identity": "A durable signed-in profile is required to save writing profiles.",
        offline: "Connect to the Gateway to load or save writing profiles.",
        stale:
          "The connection changed. Your unsaved edits are still here; export your draft, then refresh the saved version before saving.",
        error:
          "Loading or saving could not be confirmed. Your draft is retained. Refresh the saved version to check the outcome before retrying a save.",
      },
      composer: {
        selectLabel: "Writing profile",
        automatic: "Automatic / global default",
        baseline: "Profiles disabled for this session",
        disable: "Disable profiles for this session",
        inspect: "Profile details",
        original: "Original transcript",
        recover: "Review original",
        reprocess: "Reprocess unsent draft",
        status: "Status",
        reason: "Selection reason",
        unavailable: "Requested processing is unavailable; the transcript is preserved.",
        advisory: "Register suggestions are advisory. No rewrite is applied.",
        externalUnsupported:
          "External application and browser-origin matching is unavailable in this client.",
        settings: "Manage writing profiles",
        recoveryUnavailable:
          "Original transcript unavailable after cancellation or a permission change.",
        draftChanged: "The draft changed. Review the original before replacing any text.",
        preview:
          "Preview only. The original transcript is preserved; no text has been inserted or sent again.",
        previewUnavailable:
          "A new preview is unavailable while capture is busy or the draft has changed. Review the original before changing any text.",
        nextRecording: "Next recording",
        activeRecording: "Active or pending recording",
        capturedRecording: "Captured recording",
        diagnostics: "Profile diagnostics",
        diagnosticsHelp:
          "Selection and availability only. These diagnostics contain no transcript, application identity, origin, or selectors.",
        revision: "Profile revision",
        noProfile: "No profile",
        outcome: "Last publication",
        loadStatuses: {
          idle: "Profile settings have not loaded.",
          loading: "Loading profile settings…",
          ready: "Profile settings loaded.",
          unavailable: "Profile settings are unavailable. Baseline dictation is preserved.",
          error: "Profile settings could not be loaded. Baseline dictation is preserved.",
        },
        selectionStatuses: {
          disabled: "Disabled",
          active: "Active",
          unavailable: "Requested processing unavailable",
          restricted: "Restricted to the permitted baseline",
          conflict: "Conflicting selectors; using fallback",
          baseline: "Baseline",
        },
        reasons: {
          disabled: "Writing profiles are disabled.",
          "session-override": "Your selection for this session takes priority.",
          "application-origin": "Matched the application and exact origin.",
          application: "Matched the application identity.",
          "global-default": "Using the saved global default.",
          "identity-unavailable": "External context is unavailable; using the global fallback.",
          "override-unavailable": "The selected profile is unavailable; using the global fallback.",
          "selector-conflict": "Equal-priority selectors conflict; using the global fallback.",
          "no-default": "No profile matched and no global default is set.",
        },
        outcomes: {
          none: "No transcript published yet.",
          committed: "Transcript added to the draft.",
          "not-applied":
            "Transcript was not added to the draft. The original is available for review.",
          unknown:
            "Publication could not be confirmed. Review the draft before inserting anything again.",
          preview: "Original transcript previewed without changing the draft.",
          stale: "This recording is no longer current.",
        },
      },
    },
  },
} satisfies TranslationMap;

export const registerDictationWritingProfilesEnglish = Object.assign(
  () => Object.assign(en.talkPage, enDictationWritingProfiles.talkPage),
  { catalog: enDictationWritingProfiles },
);
