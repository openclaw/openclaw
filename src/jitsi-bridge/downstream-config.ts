import fs from "node:fs";
import path from "node:path";

export type JitsiBridgePromptConfig = {
  baseInstructions: string[];
  briefingTemplate: string;
  noBriefingTemplate: string;
};

export type JitsiBridgeDelegationConfig = {
  toolName: string;
  toolDescription: string;
  toolMessageDescription: string;
  inFlightReply: string;
  emptyReply: string;
};

export type JitsiBridgeTelegramUiConfig = {
  createButton: string;
  joinButton: string;
  briefingButton: string;
  questionButton: string;
  refreshButton: string;
  clearButton: string;
  emptyPanelText: string;
  emptyPanelHint: string;
  pendingBriefingHint: string;
  pendingQuestionHint: string;
};

export type JitsiBridgeIdentityConfig = {
  displayName: string;
  inviteEmail?: string;
  roomTopicFallback: string;
};

export type JitsiBridgeDownstreamConfig = {
  identity: JitsiBridgeIdentityConfig;
  prompt: JitsiBridgePromptConfig;
  delegation: JitsiBridgeDelegationConfig;
  telegramUi: JitsiBridgeTelegramUiConfig;
};

export const DEFAULT_JITSI_BRIDGE_DOWNSTREAM_CONFIG: JitsiBridgeDownstreamConfig = {
  identity: {
    displayName: "Meeting Assistant",
    inviteEmail: undefined,
    roomTopicFallback: "meeting-briefing",
  },
  prompt: {
    baseInstructions: [
      "Du bist ein technischer Meeting-Assistent in einem Business-Meeting.",
      "Sprich knapp, sachlich und in modernem Deutsch.",
      "Wenn Informationen fehlen, stelle eine kurze Rueckfrage statt zu halluzinieren.",
      "Wenn ein Tool-Ergebnis vorliegt: gib den Inhalt direkt, klar und knapp wieder. Keine freie Neuerfindung oder Umdeutung.",
      "Wenn die Funktion fehlschlaegt oder keine Daten liefert, erklaere das einmal kurz und frage nach einer Alternative statt erneut zu delegieren.",
      "WICHTIG ZU TOOLS: Nutze Delegation nur dann, wenn aktuelles Wissen, externe Daten, Systemaktionen oder Recherche noetig sind.",
      "Uebergib dabei die Nutzerfrage moeglichst woertlich als message.",
      "WICHTIG: Pro Nutzeranfrage hoechstens EINEN Tool-Call. Keine automatischen Wiederholungen.",
    ],
    briefingTemplate: "Aktuelles Briefing fuer Raum {{roomId}}:\n{{briefing}}",
    noBriefingTemplate: "Kein separates Briefing hinterlegt fuer Raum {{roomId}}.",
  },
  delegation: {
    toolName: "delegate_to_openclaw_agent",
    toolDescription:
      "Delegiert komplexe Aufgaben an den vollwertigen OpenClaw-Agenten mit allen konfigurierten Tools.",
    toolMessageDescription:
      "Konkrete Arbeitsanweisung fuer den OpenClaw-Agenten. So praezise wie moeglich formulieren.",
    inFlightReply:
      "Ich bearbeite gerade bereits eine externe Anfrage. Bitte wiederhole die Frage in ein paar Sekunden.",
    emptyReply: "Der delegierte OpenClaw-Agent hat keine textuelle Antwort geliefert.",
  },
  telegramUi: {
    createButton: "Neues Meeting",
    joinButton: "Beitreten",
    briefingButton: "Briefing senden",
    questionButton: "Frage testen",
    refreshButton: "Aktualisieren",
    clearButton: "Meeting loesen",
    emptyPanelText: "Kein aktives Meeting in diesem Chat.",
    emptyPanelHint: "Nutze den Button unten, um ein neues Meeting zu starten.",
    pendingBriefingHint:
      "Schick jetzt einfach die naechste Nachricht. Ich haenge sie als Briefing an dieses Meeting an.",
    pendingQuestionHint:
      "Schick jetzt einfach die naechste Nachricht. Ich sende sie als Testfrage an den Meeting-Assistenten.",
  },
};

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const lines = value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return lines.length > 0 ? lines : undefined;
}

function resolveDownstreamConfigPath(): string | undefined {
  const explicit =
    process.env.OPENCLAW_JITSI_CONFIG_PATH?.trim() ||
    process.env.JITSI_DOWNSTREAM_CONFIG_PATH?.trim() ||
    process.env.OPENCLAW_DOWNSTREAM_CONFIG_PATH?.trim();
  if (!explicit) {
    return undefined;
  }
  return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
}

let cachedConfigPath: string | undefined;
let cachedConfig: JitsiBridgeDownstreamConfig | undefined;

export function loadJitsiBridgeDownstreamConfig(): JitsiBridgeDownstreamConfig {
  const configPath = resolveDownstreamConfigPath();
  if (cachedConfig && cachedConfigPath === configPath) {
    return cachedConfig;
  }

  const base = DEFAULT_JITSI_BRIDGE_DOWNSTREAM_CONFIG;
  if (!configPath) {
    cachedConfigPath = configPath;
    cachedConfig = base;
    return base;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const root = asObject(parsed);
    if (!root) {
      cachedConfigPath = configPath;
      cachedConfig = base;
      return base;
    }
    const identity = asObject(root.identity);
    const prompt = asObject(root.prompt);
    const delegation = asObject(root.delegation);
    const telegramUi = asObject(root.telegramUi);

    const merged: JitsiBridgeDownstreamConfig = {
      identity: {
        displayName: asString(identity?.displayName) || base.identity.displayName,
        inviteEmail: asString(identity?.inviteEmail) ?? base.identity.inviteEmail,
        roomTopicFallback: asString(identity?.roomTopicFallback) || base.identity.roomTopicFallback,
      },
      prompt: {
        baseInstructions: asStringList(prompt?.baseInstructions) || base.prompt.baseInstructions,
        briefingTemplate: asString(prompt?.briefingTemplate) || base.prompt.briefingTemplate,
        noBriefingTemplate: asString(prompt?.noBriefingTemplate) || base.prompt.noBriefingTemplate,
      },
      delegation: {
        toolName: asString(delegation?.toolName) || base.delegation.toolName,
        toolDescription: asString(delegation?.toolDescription) || base.delegation.toolDescription,
        toolMessageDescription:
          asString(delegation?.toolMessageDescription) || base.delegation.toolMessageDescription,
        inFlightReply: asString(delegation?.inFlightReply) || base.delegation.inFlightReply,
        emptyReply: asString(delegation?.emptyReply) || base.delegation.emptyReply,
      },
      telegramUi: {
        createButton: asString(telegramUi?.createButton) || base.telegramUi.createButton,
        joinButton: asString(telegramUi?.joinButton) || base.telegramUi.joinButton,
        briefingButton: asString(telegramUi?.briefingButton) || base.telegramUi.briefingButton,
        questionButton: asString(telegramUi?.questionButton) || base.telegramUi.questionButton,
        refreshButton: asString(telegramUi?.refreshButton) || base.telegramUi.refreshButton,
        clearButton: asString(telegramUi?.clearButton) || base.telegramUi.clearButton,
        emptyPanelText: asString(telegramUi?.emptyPanelText) || base.telegramUi.emptyPanelText,
        emptyPanelHint: asString(telegramUi?.emptyPanelHint) || base.telegramUi.emptyPanelHint,
        pendingBriefingHint:
          asString(telegramUi?.pendingBriefingHint) || base.telegramUi.pendingBriefingHint,
        pendingQuestionHint:
          asString(telegramUi?.pendingQuestionHint) || base.telegramUi.pendingQuestionHint,
      },
    };
    cachedConfigPath = configPath;
    cachedConfig = merged;
    return merged;
  } catch {
    cachedConfigPath = configPath;
    cachedConfig = base;
    return base;
  }
}
