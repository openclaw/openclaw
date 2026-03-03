import { z } from "zod";

const MarketTypeSchema = z.enum(["crypto", "us-equity", "hk-equity", "cn-a-share", "multi"]);

const ExchangeConfigSchema = z.object({
  exchange: z.string(),
  apiKey: z.string().optional(),
  secret: z.string().optional(),
  testnet: z.boolean().optional(),
  paper: z.boolean().optional(),
  ctpBrokerId: z.string().optional(),
  ctpFrontAddr: z.string().optional(),
  ctpAppId: z.string().optional(),
  ctpAuthCode: z.string().optional(),
}).passthrough();

const RiskConfigSchema = z.object({
  enabled: z.boolean(),
  maxAutoTradeUsd: z.number().optional(),
  confirmThresholdUsd: z.number().optional(),
  maxDailyLossUsd: z.number().optional(),
  maxPositionPct: z.number().optional(),
  maxLeverage: z.number().optional(),
  allowedPairs: z.array(z.string()).optional(),
  blockedPairs: z.array(z.string()).optional(),
}).passthrough();

const MockTickerSchema = z.object({
  symbol: z.string(),
  last: z.number(),
  bid: z.number().optional(),
  ask: z.number().optional(),
  volume24h: z.number().optional(),
});

const SetupSchema = z.object({
  exchangeId: z.string(),
  exchangeConfig: ExchangeConfigSchema,
  riskConfig: RiskConfigSchema.optional(),
  mockTicker: MockTickerSchema.optional(),
  currentTime: z.string(), // ISO 8601
});

const CustomAssertionSchema = z.object({
  path: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains"]),
  value: z.unknown(),
});

const ExpectedSchema = z.object({
  success: z.boolean(),
  blocked: z.boolean().optional(),
  requiresConfirmation: z.boolean().optional(),
  reasonContains: z.string().optional(),
  errorContains: z.string().optional(),
  estimatedValueUsdRange: z.tuple([z.number(), z.number()]).optional(),
  marketOpen: z.boolean().optional(),
  lotSizeValid: z.boolean().optional(),
  customAssertions: z.array(CustomAssertionSchema).optional(),
});

const InputSchema = z.object({
  tool: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export const ScenarioSchema = z.object({
  id: z.string(),
  category: z.string(),
  name: z.string(),
  description: z.string(),
  market: MarketTypeSchema,
  setup: SetupSchema,
  input: InputSchema,
  expected: ExpectedSchema,
  tags: z.array(z.string()),
  notes: z.string().optional(),
});

export type Scenario = z.infer<typeof ScenarioSchema>;
export type MarketTypeValue = z.infer<typeof MarketTypeSchema>;
