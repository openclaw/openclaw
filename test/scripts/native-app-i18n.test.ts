import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { buildMacosCatalog } from "../../scripts/apple-app-i18n.ts";
import {
  assignNativeI18nIds,
  collectNativeI18nEntries,
  collectNativeI18nEntriesFromSources,
  extractNativeI18nCandidates,
  isConditionalBranchIdentifier,
  NATIVE_I18N_LOCALES,
  parseNativeI18nCommand,
  syncNativeLocale,
  type NativeI18nEntry,
  validateNativeLocaleArtifact,
} from "../../scripts/native-app-i18n.ts";
import {
  parseNativeI18nInventory,
  serializeNativeI18nInventory,
} from "../../scripts/native-i18n-inventory.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type NativeTranslationArtifact = {
  glossaryHash: string;
  locale: string;
  translations: Record<string, string>;
  version: 2;
};

function testEntry(
  id: string,
  surface: "android" | "apple",
  source: string,
  sitePath = `apps/${surface}/Fixture.${surface === "apple" ? "swift" : "kt"}`,
  kind = "ui-call",
): NativeI18nEntry {
  return { id, source, surface, sites: [{ kind, path: sitePath }] };
}

function hasSite(
  entry: NativeI18nEntry,
  predicate: (site: NativeI18nEntry["sites"][number]) => boolean,
): boolean {
  return entry.sites.some(predicate);
}

describe("native app i18n inventory", () => {
  it("serializes one extraction site per line in contiguous source-file clusters", () => {
    const entries = [
      {
        id: "native.android.fixture",
        source: 'A quoted "label"\nwith two lines',
        surface: "android",
        sites: [
          { kind: "xml-string", path: "apps/android/res/values/strings.xml" },
          { kind: "ui-call", path: "apps/android/src/Fixture.kt" },
        ],
      },
      {
        id: "native.android.retry",
        source: "Retry",
        surface: "android",
        sites: [{ kind: "ui-call", path: "apps/android/src/Fixture.kt" }],
      },
      {
        id: "native.apple.fixture",
        source: "Settings",
        surface: "apple",
        sites: [{ kind: "ui-call", path: "apps/ios/Sources/Fixture.swift" }],
      },
    ] satisfies NativeI18nEntry[];

    const contextualEntries: NativeI18nEntry[] = [...entries];
    contextualEntries[0] = {
      ...expectDefined(entries[0], "first inventory entry"),
      sourceContext: "request-only owner excerpt",
    };
    const serialized = serializeNativeI18nInventory(contextualEntries);
    const lines = serialized.trimEnd().split("\n");

    const sites = [
      {
        path: "apps/android/res/values/strings.xml",
        kind: "xml-string",
        surface: "android",
        id: "native.android.fixture",
        source: 'A quoted "label"\nwith two lines',
      },
      {
        path: "apps/ios/Sources/Fixture.swift",
        kind: "ui-call",
        surface: "apple",
        id: "native.apple.fixture",
        source: "Settings",
      },
      {
        path: "apps/android/src/Fixture.kt",
        kind: "ui-call",
        surface: "android",
        id: "native.android.fixture",
        source: 'A quoted "label"\nwith two lines',
      },
      {
        path: "apps/android/src/Fixture.kt",
        kind: "ui-call",
        surface: "android",
        id: "native.android.retry",
        source: "Retry",
      },
    ];
    expect(JSON.parse(serialized)).toEqual({ version: 3, sites });
    expect(lines).toHaveLength(sites.length + 5);
    expect(lines.slice(3, -2)).toEqual(
      sites.map(
        (site, index) => `    ${JSON.stringify(site)}${index === sites.length - 1 ? "" : ","}`,
      ),
    );
    expect(serialized).not.toContain("sourceContext");
    expect(parseNativeI18nInventory(serialized)).toEqual(entries);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("merges independent source-file edits into a fresh combined baseline", async () => {
    const sourceFile = (name: string, strings: string[]) => ({
      repoPath: `apps/macos/Sources/OpenClaw/${name}.swift`,
      surface: "apple" as const,
      source: strings.map((source) => `Text(${JSON.stringify(source)})`).join("\n"),
    });
    const base = [
      sourceFile("MainView", ["Welcome", "Retry"]),
      sourceFile("ConnectionView", ["Connection", "Retry"]),
      sourceFile("OverviewView", ["Overview", "Status"]),
      sourceFile("SettingsView", ["Settings", "Preferences"]),
    ];
    const branchA = sourceFile("SidebarFilters", ["Retry", "Group by", "Project"]);
    const branchB = sourceFile("SidebarHovercard", ["Retry", "Group chat", "Project"]);
    const serialize = (sources: typeof base) =>
      serializeNativeI18nInventory(collectNativeI18nEntriesFromSources(sources));
    const directory = tempDirs.make("openclaw-native-i18n-merge-");
    const basePath = path.join(directory, "base.json");
    const oursPath = path.join(directory, "ours.json");
    const theirsPath = path.join(directory, "theirs.json");
    await Promise.all([
      writeFile(basePath, serialize(base)),
      writeFile(oursPath, serialize([...base, branchA])),
      writeFile(theirsPath, serialize([...base, branchB])),
    ]);
    const merged = spawnSync("git", ["merge-file", "-p", oursPath, basePath, theirsPath], {
      encoding: "utf8",
    });
    expect(merged.status, merged.stderr || merged.stdout).toBe(0);
    expect(merged.stdout).toBe(serialize([...base, branchA, branchB]));
  });

  it("rejects stale or inconsistent inventories with a baseline repair hint", () => {
    const row = {
      path: "Fixture.swift",
      kind: "ui-call",
      surface: "apple",
      id: "retry",
      source: "Retry",
    };
    for (const raw of [
      JSON.stringify({ version: 2, entries: [] }),
      JSON.stringify({ version: 3, sites: [row, { ...row, source: "Cancel" }] }),
    ]) {
      expect(() => parseNativeI18nInventory(raw)).toThrow(
        /^invalid native app i18n inventory: .+; run `pnpm native:i18n:baseline`$/,
      );
    }
  });

  it("detects conditional branch identifiers without regex backtracking", () => {
    expect(isConditionalBranchIdentifier("isEnabled")).toBe(true);
    expect(isConditionalBranchIdentifier("hasFA2Enabled")).toBe(true);
    expect(isConditionalBranchIdentifier("abc123A")).toBe(false);
    expect(isConditionalBranchIdentifier("already_lowercase")).toBe(false);
    expect(isConditionalBranchIdentifier(`a${"A".repeat(4_096)}!`)).toBe(false);
  });

  it.each([{ surface: "apple", value: 'Before \\(format(")", "escaped \\")")) after' }] as const)(
    "preserves $surface nested and quoted interpolation delimiters: $value",
    ({ surface, value }) => {
      const repoPath = `apps/${surface}/Fixture.${surface === "apple" ? "swift" : "kt"}`;
      const source = `// fixture\nText("${value}")`;
      expect(extractNativeI18nCandidates(surface, repoPath, source)).toEqual([
        { kind: "ui-call", line: 2, path: repoPath, source: value, sourceContext: source, surface },
      ]);
    },
  );

  it.each([{ surface: "android", value: "Before ${outer(value)" }] as const)(
    "rejects $surface unclosed interpolation",
    ({ surface, value }) => {
      const repoPath = `apps/${surface}/Fixture.kt`;
      expect(extractNativeI18nCandidates(surface, repoPath, `Text("${value}")`)).toEqual([]);
    },
  );

  it("preserves the typed expiry key from Swift extraction through macOS catalog projection", () => {
    const entries = assignNativeI18nIds(
      extractNativeI18nCandidates(
        "apple",
        "apps/macos/Sources/OpenClaw/Expiry.swift",
        [
          "let minutes: Int = 3",
          'Label(String(format: String(localized: "Expires in %lld minutes"), minutes), systemImage: "clock")',
          'Text(verbatim: "\\(name) — \\(minutes)")',
        ].join("\n"),
      ),
    );
    const { catalog } = buildMacosCatalog({}, entries, []);
    expect(Object.keys(catalog.strings ?? {})).toEqual(["Expires in %lld minutes"]);
    expect(catalog.strings?.["Expires in %lld minutes"]?.localizations?.en?.stringUnit?.value).toBe(
      "Expires in %lld minutes",
    );
  });

  it("joins adjacent literals across supported Swift and Kotlin UI expressions", () => {
    const swift = extractNativeI18nCandidates(
      "apple",
      "apps/ios/Fixture.swift",
      `
        struct Fixture: View {
          var body: some View {
            SettingsPageHeader(
              title: "Settings",
              subtitle: "Named " + "argument")
              .help("Modifier " + "details")
            Button("Swift first " + "argument") {}
            Text(enabled ? "Enabled " + "now" : "Disabled " + "now")
            Text(LocalizedStringKey("Localized key"))
            let count = 2
            Text(AttributedString(localized: "^[\\(count) entry](inflect: true)"))
          }

          var statusText: String {
            switch state {
            case .ready:
              "Switch " + "ready"
            default:
              return "Switch " + "waiting"
            }
          }
        }
      `,
      new Set(["Button", "SettingsPageHeader", "Text"]),
    );
    const kotlin = extractNativeI18nCandidates(
      "android",
      "apps/android/Fixture.kt",
      `
        @Composable
        fun Fixture() {
          Text("Kotlin first " + "argument")
          Text(text = "Named " + "argument")
          Text(if (enabled) "Kotlin enabled " + "now" else "Kotlin disabled " + "now")
          Icon(contentDescription = if (enabled) "Open \${row.title}" else row.title)
        }

        fun statusText(state: State): String = when (state) {
          State.Ready -> "When " + "ready"
          else -> "When " + "waiting"
        }

        fun messageText(enabled: Boolean): String {
          if (enabled) return "Return " + "enabled"
          return "Return " + "disabled"
        }

        fun warningText(summary: Summary): String =
          summary.warning ?: "Fallback warning"
      `,
    );
    const sources = [...swift, ...kotlin].map((entry) => entry.source);

    expect(sources).toEqual(
      expect.arrayContaining([
        "Named argument",
        "Modifier details",
        "Swift first argument",
        "Enabled now",
        "Disabled now",
        "Localized key",
        "^[\\(count) entry](inflect: true)",
        "Switch ready",
        "Switch waiting",
        "Kotlin first argument",
        "Kotlin enabled now",
        "Kotlin disabled now",
        "Open ${row.title}",
        "When ready",
        "When waiting",
        "Return enabled",
        "Return disabled",
        "Fallback warning",
      ]),
    );
    expect(
      sources.some((source) =>
        [
          "Named ",
          "Modifier ",
          "Enabled ",
          "Disabled ",
          "Switch ",
          "Swift first ",
          "Kotlin first ",
          "Kotlin enabled ",
          "Kotlin disabled ",
          "When ",
          "Return ",
        ].includes(source),
      ),
    ).toBe(false);
  });

  it("extracts shared auth problem copy without translating commands or URLs", () => {
    const entries = collectNativeI18nEntriesFromSources([
      {
        surface: "apple",
        repoPath: "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayConnectionProblem.swift",
        source: `
          AuthProblemDefaults(
            kind: .bootstrapTokenInvalid,
            owner: .iphone,
            title: "Setup code no longer valid",
            message: "Get a fresh setup code from the Gateway owner.",
            actionLabel: "Scan QR again",
            actionCommand: "openclaw devices list",
            docsURLString: "https://docs.openclaw.ai/platforms/ios",
            retryable: false,
            pauseReconnect: true)
        `,
      },
    ]);

    expect(entries.map((entry) => entry.source)).toEqual([
      "Get a fresh setup code from the Gateway owner.",
      "Scan QR again",
      "Setup code no longer valid",
    ]);
  });

  it("collects stable Android and Apple UI entries", async () => {
    const entries = await collectNativeI18nEntries();
    const surfaces = new Set(entries.map((entry) => entry.surface));

    const sources = new Set(entries.map((entry) => entry.source));
    expect([...sources]).toEqual(
      expect.arrayContaining([
        "QR Scanner Unavailable",
        "Open ${row.title}",
        "Preview · $domain",
        "Approval command copied",
        "Save Profile",
        "Permission required",
        "Needs setup",
        "Talk failed: Realtime provider closed unexpectedly.",
        "Scan QR code",
        "Test connection",
        "Searching…",
        "Loading chat",
        "What would you like to work on?",
        "Check OpenClaw status",
        "What can I control here?",
        "Help me start voice chat",
        "Summarize the current OpenClaw status and tell me what needs attention.",
        "Show me which phone controls and device capabilities are available right now.",
        "Help me start a realtime voice session from this phone.",
        "DIARY",
        "ask OpenClaw $prompt",
        "OpenClaw is paused",
        "No threads yet",
        "Don't show this again",
        "Use Manual Gateway",
        "Session target",
        'OpenClaw uses ${labels.joinToString(", ")} permissions for features that need this access.',
        "Some channel status checks did not complete.",
        "Use the credential for this destination. Leave both fields empty only if this route already has device pairing or does not require a shared credential. Changing the destination clears this form's saved credentials.",
        "Cron changes require operator.admin. Setup codes intentionally do not grant it. Reconnect with the gateway's shared token or password to request admin access. If this device still lacks it, approve the pending scope upgrade from an existing admin client.",
        "Writes a rotating, local-only log under ~/Library/Logs/OpenClaw/. Enable only while actively debugging.",
        "A setup code supplies the address and available certificate information automatically. For token or password authentication, enter the ordinary Gateway credential below.",
        "Approve this device on the gateway.\n1) `%1$@`\n2) `/pair approve` in your OpenClaw chat\n%2$@\nOpenClaw will also retry automatically when you return to this app.",
        "The Gateway can capture your screen and interact with apps on this Mac, including clicking and typing, subject to macOS permissions.",
      ]),
    );
    for (const source of [
      "n${nodes.size}",
      '\\(day.entryCount) \\(day.entryCount == 1 ? "entry" : "entries")',
      "$(PRODUCT_BUNDLE_IDENTIFIER)",
      "ai.openclaw.screenRecord.writer",
      "false",
      "ws",
      '{"includeSecrets":true}',
      "builtIn",
    ]) {
      expect(sources.has(source), source).toBe(false);
    }
    expect(entries.length).toBeGreaterThan(100);
    expect(surfaces).toEqual(new Set(["android", "apple"]));
    expect(entries.every((entry) => entry.id.startsWith(`native.${entry.surface}.`))).toBe(true);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(
      entries.every((entry) =>
        entry.sites.every(
          (site) => !/(?:\/|\\)(?:Tests?|UITests?|test|Preview(?:s)?)(?:\/|\\)/u.test(site.path),
        ),
      ),
    ).toBe(true);
    expect(
      entries.every((entry) =>
        entry.sites.every(
          (site) => !/(?:Tests?|UITests?|Previews?|Testing)\.(?:swift|kt|kts)$/u.test(site.path),
        ),
      ),
    ).toBe(true);
    expect(
      entries.every((entry) =>
        entry.sites.every((site) => !site.path.endsWith("/NativeStringResources.kt")),
      ),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.surface === "apple")
        .every((entry) =>
          entry.sites.every((site) =>
            /^(?:apps\/ios|apps\/macos\/Sources|apps\/shared\/OpenClawKit\/Sources)\//u.test(
              site.path,
            ),
          ),
        ),
    ).toBe(true);
    expect(
      entries
        .filter((entry) => entry.surface === "android")
        .every((entry) =>
          entry.sites.every(
            (site) =>
              site.path.startsWith("apps/android/app/src/main/") ||
              site.path.startsWith("apps/android/app/src/play/") ||
              site.path.startsWith("apps/android/app/src/thirdParty/") ||
              site.path === "apps/android/wear/src/main/res/values/strings.xml" ||
              site.path ===
                "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
          ),
        ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) => site.path === "apps/android/wear/src/main/res/values/strings.xml",
          ) && entry.source === "Current session",
      ),
    ).toBe(true);
    // Wear-only entries do not reach phone resources; the phone owner must declare its modes.
    expect(
      entries
        .filter(
          (entry) =>
            entry.surface === "android" &&
            hasSite(
              entry,
              (site) =>
                site.path ===
                "apps/android/app/src/main/java/ai/openclaw/app/ui/SettingsScreens.kt",
            ),
        )
        .map((entry) => entry.source),
    ).toEqual(expect.arrayContaining(["System", "Dark", "Light"]));
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) =>
            site.path.endsWith(
              "/thirdParty/java/ai/openclaw/app/ui/SensitivePhoneCapabilitiesSettings.kt",
            ),
          ) && entry.source === "Control other apps",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) =>
            site.path.endsWith("/accessibility/AccessibilityDevActivity.kt"),
          ) && entry.source === "Accessibility executor",
      ),
    ).toBe(true);
    expect(
      entries.some((entry) =>
        new Set(["Request ID: \\(value)", "Request ID: %@"]).has(entry.source),
      ),
    ).toBe(true);
    const androidSources = new Set(
      entries.filter((entry) => entry.surface === "android").map((entry) => entry.source),
    );
    expect([...androidSources]).toEqual(
      expect.arrayContaining([
        "A prior response already allowed this command and saved the choice.",
        "A prior response already allowed this command once.",
        "A prior response already resolved this approval.",
        "Approval allowed and saved.",
        "Approval allowed once.",
        "Gateway recorded approval and saved the choice.",
        "Gateway recorded approval once.",
        "Gateway recorded a denial.",
        "This approval expired before it could be resolved.",
        "This approval was cancelled before it could be resolved.",
        "Resolution outcome unknown. Actions stay disabled until the Gateway record is verified.",
        "The Gateway still shows this approval as pending. Review it before trying again.",
        "Could not load approval details. Refresh and try again.",
        "Could not load approvals.",
        "Could not resolve approval. Refresh and try again.",
        "Command request",
      ]),
    );
    expect(
      entries.some(
        (entry) =>
          entry.surface === "apple" &&
          entry.source === "Connection…" &&
          hasSite(entry, (site) => site.path === "apps/macos/Sources/OpenClaw/MenuBar.swift"),
      ),
    ).toBe(true);
    expect(
      entries.some((entry) => entry.surface === "android" && entry.source === "Search OpenClaw"),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) => site.path.endsWith("/ChatMessageActions.kt")) &&
          entry.source === "Message actions",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) => site.path.endsWith("/ChatMessageActions.kt")) &&
          entry.source === "Reply",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) => site.path.endsWith("/ChatMessageActions.kt")) &&
          entry.source === "Share message",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) =>
              site.path ===
              "apps/ios/Sources/Settings/DeviceSettings/IOSDeviceSettingsConsent.swift",
          ) && entry.source === "Share Apple Health summaries with the Gateway?",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) => site.path === "apps/ios/Sources/Settings/DashboardPageScreen.swift",
          ) && entry.source === "Done",
      ),
    ).toBe(true);
    expect
      .soft(
        entries
          .filter(
            (entry) => entry.source === "Update the gateway to load progress cards for this agent.",
          )
          .map((entry) => entry.surface)
          .toSorted(),
      )
      .toEqual(["android", "apple"]);
    expect
      .soft(
        entries
          .filter(
            (entry) =>
              entry.source ===
              "Update the gateway before sending queued messages. This version requires safe delivery routing.",
          )
          .map((entry) => entry.surface),
      )
      .toEqual(["apple"]);
    expect(
      entries.some(
        (entry) =>
          hasSite(entry, (site) => site.path.endsWith("/ChatSheets.swift")) &&
          entry.source === "Search threads",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) => site.path === "apps/ios/WatchApp/Sources/WatchInboxView.swift",
          ) &&
          entry.source ===
            "Direct mode supports device info, status, and notifications. Voice is included when you connect from iPhone Settings → Apple Watch. Chat and approvals still use the iPhone.",
      ),
    ).toBe(true);
    expect(
      entries.some((entry) =>
        [
          "Use the credential for this destination. Leave both fields empty only if this route ",
          "Cron changes require operator.admin. Setup codes intentionally do not grant it. ",
          "Writes a rotating, local-only log under ~/Library/Logs/OpenClaw/. ",
          "A setup code supplies the address and available certificate information automatically. ",
        ].includes(entry.source),
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) =>
              site.path === "apps/ios/Sources/Gateway/GatewayConnectionSupport.swift" &&
              site.kind === "ui-localized-call-multiline",
          ) &&
          entry.source ===
            "Enable Gateway TLS, or enter your Tailscale Serve HTTPS host in Manual Setup. Use Unencrypted only with a trusted private-LAN address.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) =>
              site.path === "apps/ios/Sources/Gateway/GatewayConnectionSupport.swift" &&
              site.kind === "ui-localized-call-multiline",
          ) &&
          entry.source ===
            "Can't reach gateway at %1$@:%2$@. Check the address and your network connection.",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.source === "Approve this device on the gateway.\n")).toBe(
      false,
    );
    expect(
      entries.some((entry) =>
        entry.source.startsWith(
          "Exec approvals can only be reviewed while OpenClaw is open and connected.",
        ),
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.surface === "android" && entry.source === "INVALID_REQUEST: expected JSON object",
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.surface === "android" && ["off", "talk-orb", "pulse"].includes(entry.source),
      ),
    ).toBe(false);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) => site.path === "apps/ios/Sources/Design/SettingsProTabSections.swift",
          ) &&
          entry.source ===
            "The watch receives a one-time pairing code and its own device credentials. Voice is included with read and Talk access, without admin access. The microphone starts only when you tap Start on the watch. A reachable secure Gateway URL is required away from the iPhone.",
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          hasSite(
            entry,
            (site) =>
              site.path === "apps/macos/Sources/OpenClaw/OnboardingAISetupView.swift" &&
              site.kind === "ui-localized-call-multiline",
          ) &&
          entry.source ===
            "Include existing %@ conversations in the sidebar. This discovers them in place; it does not copy transcripts.",
      ),
    ).toBe(true);
    expect(
      entries.some((entry) => hasSite(entry, (site) => site.path.endsWith("Info.plist"))),
    ).toBe(true);
    expect(NATIVE_I18N_LOCALES).toHaveLength(21);
    expect(NATIVE_I18N_LOCALES).toContain("sv");
  });

  it("migrates v1 translations deterministically and drops stale IDs after a source edit", async () => {
    const translationsDir = tempDirs.make("openclaw-native-i18n-");
    const entries = assignNativeI18nIds([
      {
        kind: "ui-call",
        line: 1,
        path: "apps/android/Open.kt",
        source: "Open",
        surface: "android",
      },
      {
        kind: "ui-call",
        line: 2,
        path: "apps/ios/Open.swift",
        source: "Open",
        surface: "apple",
      },
      {
        kind: "ui-call",
        line: 3,
        path: "apps/ios/New.swift",
        source: "New string",
        surface: "apple",
      },
    ]);
    const androidOpen = expectDefined(
      entries.find((entry) => entry.surface === "android"),
      "Android Open entry",
    );
    const appleOpen = expectDefined(
      entries.find((entry) => entry.surface === "apple" && entry.source === "Open"),
      "Apple Open entry",
    );
    const newString = expectDefined(
      entries.find((entry) => entry.source === "New string"),
      "new source-fallback entry",
    );

    const artifactPath = path.join(translationsDir, "sv.json");
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          version: 1,
          locale: "sv",
          glossaryHash: "legacy",
          entries: [
            { id: "native.android.open-a", source: "Open", translated: "Öppna" },
            { id: "native.android.open-b", source: "Open", translated: "Öppna" },
            { id: "native.android.open-c", source: "Open", translated: "Öppen" },
            { id: "native.android.open-d", source: "Open", translated: "Open" },
            { id: "native.apple.open-a", source: "Open", translated: "Beta" },
            { id: "native.apple.open-b", source: "Open", translated: "Alfa" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const migrated = await syncNativeLocale("sv", entries, {
      glossary: [],
      translationsDir,
      translate: async () => {
        throw new Error("v1 migration must not call the translation provider");
      },
    });
    expect(migrated).toEqual({ carried: 2, changed: true, fallback: 1, translated: 0 });

    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as NativeTranslationArtifact;
    expect(artifact).toMatchObject({ locale: "sv", version: 2 });
    expect(artifact.translations).toEqual({
      [androidOpen.id]: "Öppna",
      [appleOpen.id]: "Alfa",
      [newString.id]: "New string",
    });

    const firstContents = await readFile(artifactPath, "utf8");
    const firstModifiedAt = (await stat(artifactPath)).mtimeMs;
    await expect(
      syncNativeLocale("sv", entries, {
        glossary: [],
        translationsDir,
        translate: async () => {
          throw new Error("no-op refresh must not call the provider");
        },
      }),
    ).resolves.toEqual({ carried: 3, changed: false, fallback: 1, translated: 0 });
    expect(await readFile(artifactPath, "utf8")).toBe(firstContents);
    expect((await stat(artifactPath)).mtimeMs).toBe(firstModifiedAt);

    const editedAndroid = expectDefined(
      assignNativeI18nIds([
        {
          kind: "ui-call",
          line: 10,
          path: "apps/android/Moved.kt",
          source: "Open now",
          surface: "android",
        },
      ])[0],
      "edited Android source entry",
    );
    await syncNativeLocale("sv", [editedAndroid, appleOpen, newString], {
      glossary: [],
      translationsDir,
      translate: async (pending) => new Map(pending.map((entry) => [entry.id, entry.source])),
    });
    const editedArtifact = JSON.parse(
      await readFile(artifactPath, "utf8"),
    ) as NativeTranslationArtifact;
    expect(editedArtifact.translations[androidOpen.id]).toBeUndefined();
    expect(editedArtifact.translations[editedAndroid.id]).toBe("Open now");
    expect(editedArtifact.translations[appleOpen.id]).toBe("Alfa");
  });
  it("rejects invalid native placeholders inside the translation batch", async () => {
    const translationsDir = tempDirs.make("openclaw-native-i18n-");
    const entry = testEntry("native.apple.progress", "apple", "Processed %lld of %@");
    let translatorReturned = false;

    await expect(
      syncNativeLocale("sv", [entry], {
        glossary: [],
        translationsDir,
        translate: async (_pending, locale, _glossary, validateTranslation) => {
          const translated = "Bearbetade %@";
          validateTranslation?.(entry.source, translated, entry.id, locale);
          translatorReturned = true;
          return new Map([[entry.id, translated]]);
        },
      }),
    ).rejects.toThrow(`native translation changed placeholders or line breaks for sv:${entry.id}`);
    expect(translatorReturned).toBe(false);
  });

  it("rejects unknown refresh IDs before provider calls or artifact writes", async () => {
    const translationsDir = tempDirs.make("openclaw-native-i18n-");
    const artifactPath = path.join(translationsDir, "sv.json");
    let called = false;
    await writeFile(artifactPath, "existing artifact bytes");
    await expect(
      syncNativeLocale("sv", [testEntry("native.apple.open", "apple", "Open")], {
        refreshIds: ["native.apple.unknown"],
        glossary: [],
        translationsDir,
        translate: async () => {
          called = true;
          return new Map();
        },
      }),
    ).rejects.toThrow("unknown native refresh ID");
    expect(called).toBe(false);
    expect(await readFile(artifactPath, "utf8")).toBe("existing artifact bytes");
  });

  it("validates and normalizes bounded CLI refresh selectors", () => {
    const base = ["sync", "--write", "--locale", "sv"];
    expect(
      parseNativeI18nCommand([
        ...base,
        "--refresh-id",
        "native.apple.b",
        "--refresh-id",
        "native.apple.a",
        "--refresh-id",
        "native.apple.b",
      ]).refreshIds,
    ).toEqual(["native.apple.a", "native.apple.b"]);
    const ids = Array.from({ length: 64 }, (_, index) => `native.apple.${index}`);
    const firstId = expectDefined(ids[0], "first refresh ID");
    expect(
      parseNativeI18nCommand([
        ...base,
        ...ids.flatMap((id) => ["--refresh-id", id]),
        "--refresh-id",
        firstId,
      ]).refreshIds,
    ).toHaveLength(64);
    expect(() =>
      parseNativeI18nCommand([
        ...base,
        ...[...ids, "native.apple.extra"].flatMap((id) => ["--refresh-id", id]),
      ]),
    ).toThrow("64 distinct");
    expect(() => parseNativeI18nCommand([...base, "--refresh-id"])).toThrow("requires an ID");
    expect(() => parseNativeI18nCommand([...base, "--refresh-id", "--force"])).toThrow(
      "requires an ID",
    );
    expect(() => parseNativeI18nCommand([...base, "--force", "--refresh-id", firstId])).toThrow(
      "cannot combine",
    );
    for (const args of [
      ["sync"],
      ["sync", "--write"],
      ["sync", "--locale", "sv"],
      ["baseline", "--write"],
      ["check"],
      ["verify"],
    ]) {
      expect(() => parseNativeI18nCommand([...args, "--refresh-id", firstId])).toThrow(
        "requires `sync --write --locale",
      );
    }
  });

  it("rejects invalid v2 locale artifact structure and translations", () => {
    const inventory = [
      testEntry(
        "native.android.greeting",
        "android",
        "Hello ${name}\nNext",
        "apps/android/Greeting.kt",
      ),
      testEntry("native.apple.other", "apple", "Other", "apps/ios/Other.swift"),
    ];
    const greeting = expectDefined(inventory[0], "native greeting inventory entry");
    const other = expectDefined(inventory[1], "native other inventory entry");
    const emptyGlossaryHash = createHash("sha256").update(JSON.stringify([])).digest("hex");
    const createArtifact = (): NativeTranslationArtifact => ({
      version: 2,
      locale: "sv",
      glossaryHash: emptyGlossaryHash,
      translations: {
        [greeting.id]: "Hej ${name}\nNästa",
        [other.id]: "Annat",
      },
    });
    const cases: Array<{
      expected: string;
      mutate: (artifact: NativeTranslationArtifact) => unknown;
    }> = [
      {
        expected: "version must be 2",
        mutate: (artifact) => ({ ...artifact, version: 1 }),
      },
      {
        expected: 'locale must be "sv"',
        mutate: (artifact) => ({ ...artifact, locale: "de" }),
      },
      {
        expected: "glossaryHash must be",
        mutate: (artifact) => ({ ...artifact, glossaryHash: "stale" }),
      },
      {
        expected: "translations must be a plain object",
        mutate: (artifact) => ({ ...artifact, translations: [] }),
      },
      {
        expected: `missing translation for ${other.id}`,
        mutate: (artifact) => {
          const { [other.id]: _, ...translations } = artifact.translations;
          return { ...artifact, translations };
        },
      },
      {
        expected: 'unknown translation id "native.apple.unknown"',
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, "native.apple.unknown": "Okänd" },
        }),
      },
      {
        expected: "translation must be a string for native.apple.unknown",
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, "native.apple.unknown": 12 },
        }),
      },
      {
        expected: `translation must be nonempty for ${other.id}`,
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, [other.id]: "  " },
        }),
      },
      {
        expected: `native translation changed placeholders or line breaks for sv:${greeting.id}`,
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, [greeting.id]: "Hej\nNästa" },
        }),
      },
      {
        expected: `native translation changed placeholders or line breaks for sv:${greeting.id}`,
        mutate: (artifact) => ({
          ...artifact,
          translations: { ...artifact.translations, [greeting.id]: "Hej ${name} Nästa" },
        }),
      },
    ];

    expect(validateNativeLocaleArtifact("sv", inventory, createArtifact())).toEqual([]);
    const obsolete = {
      ...createArtifact(),
      translations: { ...createArtifact().translations, "native.apple.unknown": "Okänd" },
    };
    const warnings: string[] = [];
    expect(
      validateNativeLocaleArtifact("sv", inventory, obsolete, [], (message) =>
        warnings.push(message),
      ),
    ).toEqual([]);
    expect(warnings).toEqual(['native locale sv: unknown translation id "native.apple.unknown"']);
    for (const testCase of cases) {
      expect(() =>
        validateNativeLocaleArtifact("sv", inventory, testCase.mutate(createArtifact())),
      ).toThrow(testCase.expected);
      if (testCase.expected !== 'unknown translation id "native.apple.unknown"') {
        expect(() =>
          validateNativeLocaleArtifact("sv", inventory, testCase.mutate(obsolete), [], (message) =>
            warnings.push(message),
          ),
        ).toThrow(testCase.expected);
      }
    }
  });

  it("emits deterministic advisory translation-quality findings", () => {
    const inventory: NativeI18nEntry[] = [
      testEntry(
        "native.android.language-picker",
        "android",
        "OpenClaw translations · $languageTag",
        "apps/android/app/src/main/java/ai/openclaw/app/AppLanguage.kt",
        "conditional-branch",
      ),
      testEntry("native.android.inspect", "android", "Inspect", "apps/android/Workshop.kt"),
      testEntry("native.apple.inspect", "apple", "Inspect", "apps/ios/Workshop.swift"),
      testEntry(
        "native.android.voice-note",
        "android",
        "Record voice note",
        "apps/android/Voice.kt",
      ),
    ];
    const languagePicker = expectDefined(inventory[0], "native language picker inventory entry");
    const androidInspect = expectDefined(inventory[1], "native Android inspect inventory entry");
    const appleInspect = expectDefined(inventory[2], "native Apple inspect inventory entry");
    const voiceNote = expectDefined(inventory[3], "native voice note inventory entry");
    const artifact: NativeTranslationArtifact = {
      version: 2,
      locale: "id",
      glossaryHash: createHash("sha256").update(JSON.stringify([])).digest("hex"),
      translations: {
        [languagePicker.id]: languagePicker.source,
        [androidInspect.id]: androidInspect.source,
        [appleInspect.id]: "Periksa",
        [voiceNote.id]: "Ghi ghi chú thoại",
      },
    };

    const findings = validateNativeLocaleArtifact("id", inventory, artifact);
    expect(findings.map((finding) => `${finding.code}:${finding.id}`)).toEqual([
      "adjacent-duplicate-word:native.android.voice-note",
      "android-language-picker-source-equal:native.android.language-picker",
      "same-source-contradiction:native.android.inspect",
      "source-equal:native.android.inspect",
      "source-equal:native.android.language-picker",
    ]);
    expect(findings[0]?.words).toEqual(["ghi"]);
    expect(findings[2]?.relatedIds).toEqual(["native.apple.inspect"]);
  });

  it("validates locale refresh arguments before write paths run", () => {
    expect(parseNativeI18nCommand(["baseline", "--write"])).toEqual({
      command: "baseline",
      locale: undefined,
      write: true,
    });
    expect(parseNativeI18nCommand(["verify"])).toEqual({
      command: "verify",
      locale: undefined,
      write: false,
    });
    expect(parseNativeI18nCommand(["sync", "--write", "--locale", "sv"])).toEqual({
      command: "sync",
      locale: "sv",
      write: true,
    });
    expect(() => parseNativeI18nCommand(["sync", "--write", "--locale"])).toThrow(
      "requires a locale value",
    );
    expect(parseNativeI18nCommand(["sync", "--write", "--locale", "sv", "--force"]).force).toBe(
      true,
    );
    expect(() => parseNativeI18nCommand(["sync", "--write", "--force"])).toThrow(
      "requires `sync --write --locale",
    );
    expect(() => parseNativeI18nCommand(["sync", "--write", "--locale", "--write"])).toThrow(
      "requires a locale value",
    );
    expect(() => parseNativeI18nCommand(["sync", "--write", "--locale", "xx"])).toThrow(
      "unsupported native locale",
    );
    expect(() => parseNativeI18nCommand(["check", "--locale", "sv"])).toThrow(
      "requires `sync --write",
    );
    expect(() => parseNativeI18nCommand(["baseline"])).toThrow("requires `--write`");
    expect(() => parseNativeI18nCommand(["verify", "--write"])).toThrow(
      "does not accept `--write`",
    );
  });
});
