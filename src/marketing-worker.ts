import OpenAI from "openai";
import axios from "axios";
import Stripe from "stripe";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_PRIMARY_MODEL = "openai/gpt-4o";
const DEFAULT_FALLBACK_MODEL = "deepseek/deepseek-chat";

const LEAD_STAGES = ["NEW_LEAD", "QUALIFIED", "BOOKED", "CONVERTED", "LOST"] as const;

type LeadStage = (typeof LEAD_STAGES)[number];

type ConversationState = {
  id: string;
  status: LeadStage;
  lastMessage: string;
  updatedAt: string;
  adId?: string;
  campaignId?: string;
};

type CampaignMetrics = {
  campaignId: string;
  spend: number;
  clicks: number;
  impressions: number;
  purchases: number;
  leads: number;
  revenue: number;
  whatsappQualified: number;
  whatsappBooked: number;
  whatsappConverted: number;
};

type CampaignAttribution = {
  campaignId: string;
  revenue: number;
  conversions: number;
};

export interface Env {
  OPENROUTER_API_KEY: string;
  FB_ACCESS_TOKEN: string;
  WHATSAPP_TOKEN: string;
  STRIPE_SECRET_KEY: string;
  LLM_MODEL?: string;
  LLM_FALLBACK?: string;
  BASE_URL?: string;
  conversations: KVNamespace;
  metrics: KVNamespace;
  attribution: KVNamespace;
}

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

const getOpenRouterClient = (env: Env) =>
  new OpenAI({
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: env.BASE_URL ?? DEFAULT_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw",
    },
  });

const getModelConfig = (env: Env) => ({
  primary: env.LLM_MODEL ?? DEFAULT_PRIMARY_MODEL,
  fallback: env.LLM_FALLBACK ?? DEFAULT_FALLBACK_MODEL,
});

const parseJson = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const ensureWhatsAppAuth = (request: Request, env: Env) => {
  const token = request.headers.get("x-whatsapp-token");
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  return token === env.WHATSAPP_TOKEN || bearer === env.WHATSAPP_TOKEN;
};

const coerceNumber = (value: string | number | undefined) => {
  if (value === undefined) {
    return 0;
  }
  const num = typeof value === "number" ? value : Number(value);
  return Number.isNaN(num) ? 0 : num;
};

const formatLeadStage = (stage: string): LeadStage => {
  if (LEAD_STAGES.includes(stage as LeadStage)) {
    return stage as LeadStage;
  }
  return "NEW_LEAD";
};

const computeHeuristicStage = (message: string, current: LeadStage): LeadStage | null => {
  const normalized = message.toLowerCase();
  if (/(not interested|stop|unsubscribe|no thanks)/.test(normalized)) {
    return "LOST";
  }
  if (/(paid|receipt|invoice|charged|payment)/.test(normalized)) {
    return "CONVERTED";
  }
  if (/(booked|schedule|appointment|calendar|reservation)/.test(normalized)) {
    return "BOOKED";
  }
  if (current === "NEW_LEAD" && /(price|budget|quote|ready|interested)/.test(normalized)) {
    return "QUALIFIED";
  }
  return null;
};

const classifyLeadStage = async (env: Env, message: string, current: LeadStage) => {
  const heuristic = computeHeuristicStage(message, current);
  if (heuristic) {
    return heuristic;
  }

  const client = getOpenRouterClient(env);
  const { primary, fallback } = getModelConfig(env);
  const prompt = `You are a lead qualification assistant for OpenClaw marketing automation.\n\nReturn a JSON object with a single key \"stage\" whose value is one of: ${LEAD_STAGES.join(", ")}.\n\nCurrent stage: ${current}\nMessage: ${message}`;

  const requestModel = async (model: string) =>
    client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Respond only with compact JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });

  try {
    const response = await requestModel(primary);
    const content = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as { stage?: string };
    return formatLeadStage(parsed.stage ?? current);
  } catch {
    const response = await requestModel(fallback);
    const content = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(content) as { stage?: string };
    return formatLeadStage(parsed.stage ?? current);
  }
};

const getCampaignMetrics = async (env: Env, accountId: string) => {
  const response = await axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/campaigns`, {
    params: {
      access_token: env.FB_ACCESS_TOKEN,
      effective_status: JSON.stringify(["ACTIVE"]),
      fields:
        "id,name,status,objective,insights.date_preset(last_30d){spend,impressions,clicks,actions,action_values}",
    },
  });

  return (response.data?.data ?? []) as Array<Record<string, unknown>>;
};

const extractInsightValue = (actions: Array<{ action_type?: string; value?: string }>, type: string) => {
  const entry = actions.find((action) => action.action_type === type);
  return coerceNumber(entry?.value);
};

const buildCampaignMetrics = async (env: Env, campaigns: Array<Record<string, unknown>>) => {
  const results: CampaignMetrics[] = [];

  for (const campaign of campaigns) {
    const insights = (campaign.insights as { data?: Array<Record<string, unknown>> })?.data?.[0];
    const actions = (insights?.actions as Array<{ action_type?: string; value?: string }>) ?? [];
    const values = (insights?.action_values as Array<{ action_type?: string; value?: string }>) ?? [];
    const campaignId = String(campaign.id ?? "");
    const spend = coerceNumber(insights?.spend as string | number | undefined);
    const clicks = coerceNumber(insights?.clicks as string | number | undefined);
    const impressions = coerceNumber(insights?.impressions as string | number | undefined);
    const leads = extractInsightValue(actions, "lead");
    const purchases = extractInsightValue(actions, "purchase");
    const revenue = extractInsightValue(values, "purchase");

    const whatsappMetrics = await env.metrics.get(`whatsapp:campaign:${campaignId}`, "json");
    const attribution = (await env.attribution.get(`campaign:${campaignId}`, "json")) as
      | CampaignAttribution
      | null;

    results.push({
      campaignId,
      spend,
      clicks,
      impressions,
      leads,
      purchases,
      revenue: revenue + coerceNumber(attribution?.revenue),
      whatsappQualified: coerceNumber(whatsappMetrics?.qualified),
      whatsappBooked: coerceNumber(whatsappMetrics?.booked),
      whatsappConverted: coerceNumber(whatsappMetrics?.converted),
    });
  }

  return results;
};

const updateCampaignStatus = async (env: Env, campaignId: string, status: "PAUSED" | "ACTIVE") => {
  await axios.post(`https://graph.facebook.com/v19.0/${campaignId}`, null, {
    params: {
      access_token: env.FB_ACCESS_TOKEN,
      status,
    },
  });
};

const scaleCampaignBudget = async (env: Env, campaignId: string, multiplier: number) => {
  const currentResponse = await axios.get(`https://graph.facebook.com/v19.0/${campaignId}`, {
    params: {
      access_token: env.FB_ACCESS_TOKEN,
      fields: "daily_budget",
    },
  });
  const currentBudget = coerceNumber(currentResponse.data?.daily_budget);
  const updatedBudget = Math.round(currentBudget * multiplier);

  if (updatedBudget <= 0 || updatedBudget === currentBudget) {
    return { previous: currentBudget, updated: currentBudget };
  }

  await axios.post(`https://graph.facebook.com/v19.0/${campaignId}`, null, {
    params: {
      access_token: env.FB_ACCESS_TOKEN,
      daily_budget: updatedBudget,
    },
  });

  return { previous: currentBudget, updated: updatedBudget };
};

const handleCampaigns = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const accountId = url.searchParams.get("ad_account_id");
  if (!accountId) {
    return jsonResponse({ error: "Missing ad_account_id" }, 400);
  }
  const campaigns = await getCampaignMetrics(env, accountId);
  const metrics = await buildCampaignMetrics(env, campaigns);
  return jsonResponse({ campaigns: metrics });
};

const handleOptimize = async (request: Request, env: Env) => {
  const payload = await parseJson<{ ad_account_id?: string; target_cpa?: number }>(request);
  if (!payload?.ad_account_id || !payload.target_cpa) {
    return jsonResponse({ error: "Missing ad_account_id or target_cpa" }, 400);
  }

  const campaigns = await getCampaignMetrics(env, payload.ad_account_id);
  const metrics = await buildCampaignMetrics(env, campaigns);
  const actions: Array<Record<string, unknown>> = [];

  for (const campaign of metrics) {
    const conversions = campaign.leads + campaign.purchases + campaign.whatsappConverted;
    const cpa = conversions > 0 ? campaign.spend / conversions : 0;
    const roas = campaign.spend > 0 ? campaign.revenue / campaign.spend : 0;

    if (payload.target_cpa > 0 && cpa > payload.target_cpa * 1.3) {
      await updateCampaignStatus(env, campaign.campaignId, "PAUSED");
      actions.push({
        campaignId: campaign.campaignId,
        action: "PAUSE",
        cpa,
        targetCpa: payload.target_cpa,
      });
      continue;
    }

    if (roas > 3) {
      const budget = await scaleCampaignBudget(env, campaign.campaignId, 1.2);
      actions.push({
        campaignId: campaign.campaignId,
        action: "SCALE",
        roas,
        budget,
      });
    }
  }

  return jsonResponse({ actions, campaigns: metrics });
};

const updateWhatsAppMetrics = async (env: Env, campaignId: string, stage: LeadStage) => {
  const key = `whatsapp:campaign:${campaignId}`;
  const current = (await env.metrics.get(key, "json")) as
    | { qualified?: number; booked?: number; converted?: number }
    | null;

  const next = {
    qualified: coerceNumber(current?.qualified),
    booked: coerceNumber(current?.booked),
    converted: coerceNumber(current?.converted),
  };

  if (stage === "QUALIFIED") {
    next.qualified += 1;
  }
  if (stage === "BOOKED") {
    next.booked += 1;
  }
  if (stage === "CONVERTED") {
    next.converted += 1;
  }

  await env.metrics.put(key, JSON.stringify(next));
};

const handleWhatsAppWebhook = async (request: Request, env: Env) => {
  if (!ensureWhatsAppAuth(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const payload = await parseJson<{
    from?: string;
    message?: string;
    ad_id?: string;
    campaign_id?: string;
  }>(request);

  if (!payload?.from || !payload.message) {
    return jsonResponse({ error: "Missing from or message" }, 400);
  }

  const key = `conversation:${payload.from}`;
  const existing = (await env.conversations.get(key, "json")) as ConversationState | null;
  const currentStage = existing?.status ?? "NEW_LEAD";
  const nextStage = await classifyLeadStage(env, payload.message, currentStage);

  const state: ConversationState = {
    id: payload.from,
    status: nextStage,
    lastMessage: payload.message,
    updatedAt: new Date().toISOString(),
    adId: payload.ad_id ?? existing?.adId,
    campaignId: payload.campaign_id ?? existing?.campaignId,
  };

  await env.conversations.put(key, JSON.stringify(state));

  if (state.campaignId) {
    await updateWhatsAppMetrics(env, state.campaignId, nextStage);
  }

  if (state.adId) {
    await env.attribution.put(
      `ad:${state.adId}`,
      JSON.stringify({ adId: state.adId, campaignId: state.campaignId, lastSeenAt: state.updatedAt })
    );
  }

  return jsonResponse({ status: state.status, conversation: state });
};

const handleStripeWebhook = async (request: Request, env: Env) => {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return jsonResponse({ error: "Missing stripe-signature header" }, 400);
  }

  const body = await request.text();
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, env.STRIPE_SECRET_KEY);
  } catch (error) {
    return jsonResponse({ error: "Invalid signature", details: `${error}` }, 400);
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const adId = paymentIntent.metadata?.ad_id;
    const campaignId = paymentIntent.metadata?.campaign_id;
    const revenue = coerceNumber(paymentIntent.amount_received) / 100;

    if (campaignId) {
      const campaignKey = `campaign:${campaignId}`;
      const current = (await env.attribution.get(campaignKey, "json")) as CampaignAttribution | null;
      const next: CampaignAttribution = {
        campaignId,
        revenue: coerceNumber(current?.revenue) + revenue,
        conversions: coerceNumber(current?.conversions) + 1,
      };
      await env.attribution.put(campaignKey, JSON.stringify(next));
    }

    if (adId) {
      await env.attribution.put(
        `ad:${adId}`,
        JSON.stringify({ adId, campaignId, revenue, paidAt: new Date().toISOString() })
      );
    }
  }

  return jsonResponse({ received: true });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/campaigns") {
      return handleCampaigns(request, env);
    }

    if (request.method === "POST" && url.pathname === "/optimize") {
      return handleOptimize(request, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook/whatsapp") {
      return handleWhatsAppWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook/stripe") {
      return handleStripeWebhook(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
