import {
  RADAR_TOOL_NAMES,
  REVIEW_ANALYZERS,
  type RadarDefenderConfig,
  type RadarProductContext,
} from "../core/types.js";

export const DEFAULT_RADAR_PRODUCT_CONTEXT: RadarProductContext = {
  productName: "Radar Meseriași",
  productSummary:
    "Marketplace platform connecting homeowners with local craftsmen for jobs, bids, messaging, verification, and future payment flows.",
  roles: ["homeowner", "craftsman", "admin", "support operator", "system integration"],
  coreFlows: [
    "job creation and discovery",
    "bid and quote submission",
    "owner-craftsman messaging",
    "profile and review management",
    "OTP signup and verification",
    "webhook-driven external integrations",
  ],
  architectureSummary: [
    "Next.js App Router frontend",
    "server routes and Supabase Auth",
    "PostgreSQL with Row Level Security",
    "Twilio SMS OTP with fallback delivery paths",
    "Vercel deployment surface",
    "planned or partial Stripe payment workflows",
  ],
  priorityRiskAreas: [
    "Auth bypass",
    "Authorization / IDOR",
    "RLS policy gaps",
    "Admin privilege escalation",
    "OTP abuse / replay / enumeration",
    "Webhook verification issues",
    "XSS / unsafe rendering",
    "Sensitive data exposure",
    "Rate limiting gaps",
    "Input validation issues",
  ],
};

export const DEFAULT_RADAR_DEFENDER_CONFIG: RadarDefenderConfig = {
  server: {
    name: "radar-claw-defender",
    transport: "stdio",
  },
  review: {
    minimumSeverity: "medium",
    enabledTools: [...RADAR_TOOL_NAMES],
    enabledAnalyzers: [...REVIEW_ANALYZERS],
    outputMode: "json",
  },
  contextOverrides: {},
};
