export interface BriefingTypeConfig {
  enabled: boolean;
  schedule: string;
  delivery_channel: string;
  sections: string[];
}

export interface BriefingConfig {
  morning: BriefingTypeConfig;
  weekly: BriefingTypeConfig;
}

export const DEFAULT_BRIEFING_CONFIG: BriefingConfig = {
  morning: {
    enabled: true,
    schedule: "0 8 * * 1-5",
    delivery_channel: "whatsapp",
    sections: ["calendar", "email", "tickets", "prs", "slack"],
  },
  weekly: {
    enabled: true,
    schedule: "0 16 * * 5",
    delivery_channel: "whatsapp",
    sections: ["shipped", "in_progress", "blocked", "discussions", "numbers", "people"],
  },
};

let storedConfig: BriefingConfig | null = null;

export async function loadBriefingConfig(): Promise<BriefingConfig | null> {
  return storedConfig;
}

export async function saveBriefingConfig(config: BriefingConfig): Promise<void> {
  storedConfig = config;
}
