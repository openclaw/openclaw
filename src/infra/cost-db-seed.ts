import type { DatabaseSync } from "node:sqlite";
import { upsertPricingVersion } from "./cost-db.js";

// Pricing data as of March 2026
// Prices are per 1M tokens
type PricingSeed = {
  provider: string;
  model: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
};

const ANTHROPIC_PRICING: PricingSeed[] = [
  // Claude 4 Opus
  {
    provider: "anthropic",
    model: "claude-opus-4-20250514",
    inputPrice: 15.0,
    outputPrice: 75.0,
    cacheReadPrice: 1.5,
    cacheWritePrice: 18.75,
  },
  {
    provider: "anthropic",
    model: "claude-opus-4-5-20251101",
    inputPrice: 15.0,
    outputPrice: 75.0,
    cacheReadPrice: 1.5,
    cacheWritePrice: 18.75,
  },
  // Claude 4 Sonnet
  {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 0.3,
    cacheWritePrice: 3.75,
  },
  // Claude 3.7 Sonnet (Extended Thinking)
  {
    provider: "anthropic",
    model: "claude-3-7-sonnet-20250219",
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 0.3,
    cacheWritePrice: 3.75,
  },
  // Claude 3.5 Sonnet (v2)
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 0.3,
    cacheWritePrice: 3.75,
  },
  // Claude 3.5 Sonnet (v1)
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20240620",
    inputPrice: 3.0,
    outputPrice: 15.0,
    cacheReadPrice: 0.3,
    cacheWritePrice: 3.75,
  },
  // Claude 3.5 Haiku
  {
    provider: "anthropic",
    model: "claude-3-5-haiku-20241022",
    inputPrice: 0.8,
    outputPrice: 4.0,
    cacheReadPrice: 0.08,
    cacheWritePrice: 1.0,
  },
  // Claude 3 Opus
  {
    provider: "anthropic",
    model: "claude-3-opus-20240229",
    inputPrice: 15.0,
    outputPrice: 75.0,
    cacheReadPrice: 1.5,
    cacheWritePrice: 18.75,
  },
  // Claude 3 Haiku
  {
    provider: "anthropic",
    model: "claude-3-haiku-20240307",
    inputPrice: 0.25,
    outputPrice: 1.25,
    cacheReadPrice: 0.03,
    cacheWritePrice: 0.3,
  },
];

const OPENAI_PRICING: PricingSeed[] = [
  // GPT-4o
  {
    provider: "openai",
    model: "gpt-4o",
    inputPrice: 2.5,
    outputPrice: 10.0,
    cacheReadPrice: 1.25,
  },
  {
    provider: "openai",
    model: "gpt-4o-2024-11-20",
    inputPrice: 2.5,
    outputPrice: 10.0,
    cacheReadPrice: 1.25,
  },
  {
    provider: "openai",
    model: "gpt-4o-2024-08-06",
    inputPrice: 2.5,
    outputPrice: 10.0,
    cacheReadPrice: 1.25,
  },
  // GPT-4o mini
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    cacheReadPrice: 0.075,
  },
  {
    provider: "openai",
    model: "gpt-4o-mini-2024-07-18",
    inputPrice: 0.15,
    outputPrice: 0.6,
    cacheReadPrice: 0.075,
  },
  // o1 series
  {
    provider: "openai",
    model: "o1",
    inputPrice: 15.0,
    outputPrice: 60.0,
    cacheReadPrice: 7.5,
  },
  {
    provider: "openai",
    model: "o1-2024-12-17",
    inputPrice: 15.0,
    outputPrice: 60.0,
    cacheReadPrice: 7.5,
  },
  {
    provider: "openai",
    model: "o1-preview",
    inputPrice: 15.0,
    outputPrice: 60.0,
  },
  {
    provider: "openai",
    model: "o1-mini",
    inputPrice: 3.0,
    outputPrice: 12.0,
    cacheReadPrice: 1.5,
  },
  // o3-mini
  {
    provider: "openai",
    model: "o3-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    cacheReadPrice: 0.55,
  },
  {
    provider: "openai",
    model: "o3-mini-2025-01-31",
    inputPrice: 1.1,
    outputPrice: 4.4,
    cacheReadPrice: 0.55,
  },
  // GPT-4 Turbo
  {
    provider: "openai",
    model: "gpt-4-turbo",
    inputPrice: 10.0,
    outputPrice: 30.0,
  },
  {
    provider: "openai",
    model: "gpt-4-turbo-2024-04-09",
    inputPrice: 10.0,
    outputPrice: 30.0,
  },
  // GPT-4
  {
    provider: "openai",
    model: "gpt-4",
    inputPrice: 30.0,
    outputPrice: 60.0,
  },
  // GPT-3.5 Turbo
  {
    provider: "openai",
    model: "gpt-3.5-turbo",
    inputPrice: 0.5,
    outputPrice: 1.5,
  },
];

const GOOGLE_PRICING: PricingSeed[] = [
  // Gemini 2.5 Pro
  {
    provider: "google",
    model: "gemini-2.5-pro-preview-05-06",
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.3125,
  },
  {
    provider: "google",
    model: "gemini-2.5-pro-preview-03-25",
    inputPrice: 1.25,
    outputPrice: 10.0,
    cacheReadPrice: 0.3125,
  },
  // Gemini 2.0 Flash
  {
    provider: "google",
    model: "gemini-2.0-flash",
    inputPrice: 0.1,
    outputPrice: 0.4,
    cacheReadPrice: 0.025,
  },
  {
    provider: "google",
    model: "gemini-2.0-flash-001",
    inputPrice: 0.1,
    outputPrice: 0.4,
    cacheReadPrice: 0.025,
  },
  // Gemini 2.0 Flash-Lite
  {
    provider: "google",
    model: "gemini-2.0-flash-lite",
    inputPrice: 0.075,
    outputPrice: 0.3,
  },
  // Gemini 1.5 Pro
  {
    provider: "google",
    model: "gemini-1.5-pro",
    inputPrice: 1.25,
    outputPrice: 5.0,
    cacheReadPrice: 0.3125,
  },
  {
    provider: "google",
    model: "gemini-1.5-pro-002",
    inputPrice: 1.25,
    outputPrice: 5.0,
    cacheReadPrice: 0.3125,
  },
  // Gemini 1.5 Flash
  {
    provider: "google",
    model: "gemini-1.5-flash",
    inputPrice: 0.075,
    outputPrice: 0.3,
    cacheReadPrice: 0.01875,
  },
  {
    provider: "google",
    model: "gemini-1.5-flash-002",
    inputPrice: 0.075,
    outputPrice: 0.3,
    cacheReadPrice: 0.01875,
  },
  // Gemini 1.5 Flash-8B
  {
    provider: "google",
    model: "gemini-1.5-flash-8b",
    inputPrice: 0.0375,
    outputPrice: 0.15,
    cacheReadPrice: 0.01,
  },
];

const MISTRAL_PRICING: PricingSeed[] = [
  // Mistral Large
  {
    provider: "mistral",
    model: "mistral-large-latest",
    inputPrice: 2.0,
    outputPrice: 6.0,
  },
  {
    provider: "mistral",
    model: "mistral-large-2411",
    inputPrice: 2.0,
    outputPrice: 6.0,
  },
  // Mistral Small
  {
    provider: "mistral",
    model: "mistral-small-latest",
    inputPrice: 0.2,
    outputPrice: 0.6,
  },
  {
    provider: "mistral",
    model: "mistral-small-2503",
    inputPrice: 0.2,
    outputPrice: 0.6,
  },
  // Codestral
  {
    provider: "mistral",
    model: "codestral-latest",
    inputPrice: 0.3,
    outputPrice: 0.9,
  },
  // Pixtral Large
  {
    provider: "mistral",
    model: "pixtral-large-latest",
    inputPrice: 2.0,
    outputPrice: 6.0,
  },
  // Ministral 8B
  {
    provider: "mistral",
    model: "ministral-8b-latest",
    inputPrice: 0.1,
    outputPrice: 0.1,
  },
  // Ministral 3B
  {
    provider: "mistral",
    model: "ministral-3b-latest",
    inputPrice: 0.04,
    outputPrice: 0.04,
  },
];

const GROQ_PRICING: PricingSeed[] = [
  // Llama 3.3 70B
  {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    inputPrice: 0.59,
    outputPrice: 0.79,
  },
  // Llama 3.1 70B
  {
    provider: "groq",
    model: "llama-3.1-70b-versatile",
    inputPrice: 0.59,
    outputPrice: 0.79,
  },
  // Llama 3.1 8B
  {
    provider: "groq",
    model: "llama-3.1-8b-instant",
    inputPrice: 0.05,
    outputPrice: 0.08,
  },
  // DeepSeek R1 Distill Llama 70B
  {
    provider: "groq",
    model: "deepseek-r1-distill-llama-70b",
    inputPrice: 0.75,
    outputPrice: 0.99,
  },
  // Mixtral 8x7B
  {
    provider: "groq",
    model: "mixtral-8x7b-32768",
    inputPrice: 0.24,
    outputPrice: 0.24,
  },
];

const DEEPSEEK_PRICING: PricingSeed[] = [
  // DeepSeek Chat
  {
    provider: "deepseek",
    model: "deepseek-chat",
    inputPrice: 0.14,
    outputPrice: 0.28,
    cacheReadPrice: 0.014,
  },
  // DeepSeek Reasoner
  {
    provider: "deepseek",
    model: "deepseek-reasoner",
    inputPrice: 0.55,
    outputPrice: 2.19,
    cacheReadPrice: 0.14,
  },
];

const XAI_PRICING: PricingSeed[] = [
  // Grok 3
  {
    provider: "xai",
    model: "grok-3",
    inputPrice: 3.0,
    outputPrice: 15.0,
  },
  {
    provider: "xai",
    model: "grok-3-latest",
    inputPrice: 3.0,
    outputPrice: 15.0,
  },
  // Grok 3 Mini
  {
    provider: "xai",
    model: "grok-3-mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
  },
  {
    provider: "xai",
    model: "grok-3-mini-latest",
    inputPrice: 0.3,
    outputPrice: 0.5,
  },
  // Grok 2
  {
    provider: "xai",
    model: "grok-2",
    inputPrice: 2.0,
    outputPrice: 10.0,
  },
  {
    provider: "xai",
    model: "grok-2-latest",
    inputPrice: 2.0,
    outputPrice: 10.0,
  },
];

const ALL_PRICING: PricingSeed[] = [
  ...ANTHROPIC_PRICING,
  ...OPENAI_PRICING,
  ...GOOGLE_PRICING,
  ...MISTRAL_PRICING,
  ...GROQ_PRICING,
  ...DEEPSEEK_PRICING,
  ...XAI_PRICING,
];

export function seedPricingData(db: DatabaseSync, effectiveDate?: number): void {
  const date = effectiveDate ?? Date.now();

  for (const pricing of ALL_PRICING) {
    upsertPricingVersion(db, {
      provider: pricing.provider,
      model: pricing.model,
      effectiveDate: date,
      inputPrice: pricing.inputPrice,
      outputPrice: pricing.outputPrice,
      cacheReadPrice: pricing.cacheReadPrice ?? null,
      cacheWritePrice: pricing.cacheWritePrice ?? null,
    });
  }
}

export { ALL_PRICING };
