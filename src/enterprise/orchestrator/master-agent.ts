/**
 * Master Agent — The Business-Running OS Brain
 *
 * Users talk to this agent. It creates sub-agents that generate real revenue.
 * It forms businesses, tracks income, manages compliance, and scales operations.
 *
 * The agents ARE the business. They close deals, deliver services,
 * collect payments, and hit revenue targets autonomously.
 */

import { getBalance, getTransactionHistory } from "../billing/credits.js";
import { getDailyUsage, getUsageSummary } from "../billing/usage-meter.js";
import {
  startFormation,
  estimateFormationCost,
  getFormationStatus,
  listOrgEntities,
  getUpcomingCompliance,
} from "../formation/formation-engine.js";
import type { EntityType, USState } from "../formation/types.js";
import {
  recordRevenue,
  getBusinessHealth,
  createClient,
  createDeal,
  createInvoice,
  getPipelineValue,
  setRevenueGoal,
  getAgentRevenue,
} from "../revenue/revenue-engine.js";
import type { RevenueSource } from "../revenue/types.js";
import type { OrgId } from "../tenants/types.js";
import type { AgentSpec } from "./agent-spawner.js";
import {
  destroyAgent,
  getAgentStatus,
  listOrgAgents,
  modifyAgent,
  spawnAgent,
} from "./agent-spawner.js";

// ── Master Agent System Prompt ───────────────────────────────────────────────

export const MASTER_AGENT_SYSTEM_PROMPT = `You are an AI Operating System that RUNS businesses and GENERATES real revenue.

You don't just manage agents — you ARE the business. Your agents close deals, deliver services, collect payments, and grow the company. Every dollar they earn is tracked. Your job is to hit $10K/month and beyond.

## What You Do

### Build the Business
- **Form companies**: "Form my LLC in Wyoming" — you handle incorporation, EIN, registered agent, bank account, everything
- **Create revenue agents**: Sales agents that close deals, support agents that retain customers, content agents that drive traffic
- **Track every dollar**: Real-time revenue dashboard, client CRM, deal pipeline, invoicing

### Run the Business
- **Sales agents** prospect, qualify, pitch, and close. Track deals from lead to closed-won.
- **Support agents** handle customers 24/7, upsell, and reduce churn.
- **Content agents** create posts, newsletters, social media — driving inbound leads.
- **Ops agents** monitor systems, handle compliance, file reports on time.
- **Service agents** deliver actual work: research, writing, analysis, consulting.

### Revenue Math — How to Hit $10K/month
- Sales agent closing 3 deals/week at $500 avg = **$6,000/mo**
- Support agent retaining 20 clients at $200/mo = **$4,000/mo saved**
- Content agent driving 50 leads/mo, 10% close rate at $300 = **$1,500/mo**
- Service agent delivering 40 consulting hours at $150/hr = **$6,000/mo**
- Mix and match to exceed $10K/mo

### Business Formation
Say "form my LLC" and I handle:
1. Name availability check
2. Articles of Organization filing
3. Operating Agreement generation
4. EIN application with the IRS
5. Registered agent setup
6. Business bank account (Mercury, Relay, or Bluevine)
7. Compliance calendar with automated reminders
Wyoming LLC: ~$199 total. Delaware LLC: ~$189 total.

## Rules
1. **Revenue first.** Every agent should have a clear path to generating or protecting revenue.
2. **Track everything.** Record every client, deal, invoice, and payment.
3. **Be transparent on costs.** Show agent run costs vs. revenue generated. ROI matters.
4. **Proactive compliance.** Never miss a filing deadline. Automate everything.
5. **Scale what works.** If an agent is profitable, suggest scaling it up.

## Cost vs Revenue
- Agent run cost: $0.05-0.50 per execution
- A sales agent that costs $50/month in runs but closes $5,000 in deals = 100x ROI
- Always show the ROI when reporting on agents`;

// ── Tool Infrastructure ──────────────────────────────────────────────────────

export interface MasterAgentTool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  required: string[];
  handler: (orgId: OrgId, params: Record<string, unknown>) => Promise<string>;
}

interface ToolParameter {
  type: string;
  description: string;
  items?: { type: string };
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

export const MASTER_AGENT_TOOLS: MasterAgentTool[] = [
  // ── Agent Management ──────────────────────────────────────────────────────
  {
    name: "create_agent",
    description:
      "Create and deploy a revenue-generating agent. Every agent should have a clear revenue purpose.",
    parameters: {
      name: { type: "string", description: "Agent name" },
      purpose: {
        type: "string",
        description: "Revenue purpose (e.g., 'close inbound leads via WhatsApp')",
      },
      system_prompt: { type: "string", description: "Detailed behavior instructions" },
      tools: {
        type: "array",
        description:
          "Tools: web_search, send_message, image_generate, http_request, calendar, email, stripe_create_invoice, crm_update",
        items: { type: "string" },
      },
      channels: {
        type: "array",
        description: "Channels: whatsapp, telegram, slack, discord, email, webchat",
        items: { type: "string" },
      },
      cron_schedule: { type: "string", description: "Cron expression for scheduled runs" },
      channel_target: { type: "string", description: "Default delivery target" },
      revenue_target_cents: {
        type: "number",
        description: "Monthly revenue target for this agent (cents)",
      },
    },
    required: ["name", "purpose", "system_prompt"],
    handler: handleCreateAgent,
  },
  {
    name: "list_agents",
    description: "List all agents with status, revenue generated, and ROI.",
    parameters: {},
    required: [],
    handler: handleListAgents,
  },
  {
    name: "stop_agent",
    description: "Stop a running agent.",
    parameters: { agent_id: { type: "string", description: "Agent ID" } },
    required: ["agent_id"],
    handler: handleStopAgent,
  },
  {
    name: "modify_agent",
    description: "Update agent behavior, schedule, channels, or tools.",
    parameters: {
      agent_id: { type: "string", description: "Agent ID" },
      system_prompt: { type: "string", description: "New system prompt" },
      cron_schedule: { type: "string", description: "New cron schedule (or 'none')" },
      tools: { type: "array", description: "New tool list", items: { type: "string" } },
      channels: { type: "array", description: "New channel list", items: { type: "string" } },
    },
    required: ["agent_id"],
    handler: handleModifyAgent,
  },
  {
    name: "agent_metrics",
    description: "Detailed agent performance: runs, costs, revenue generated, ROI.",
    parameters: { agent_id: { type: "string", description: "Agent ID" } },
    required: ["agent_id"],
    handler: handleAgentMetrics,
  },

  // ── Business Formation ────────────────────────────────────────────────────
  {
    name: "form_business",
    description:
      "Start automated business formation (LLC, Corp, DBA). Handles filing, EIN, registered agent, bank account.",
    parameters: {
      company_name: { type: "string", description: "Business name" },
      entity_type: { type: "string", description: "Entity type: llc, s_corp, c_corp, dba" },
      state: { type: "string", description: "US state code (e.g., WY, DE, FL)" },
      business_purpose: { type: "string", description: "What the business does" },
      request_ein: { type: "string", description: "Request EIN from IRS (yes/no)" },
      open_bank_account: { type: "string", description: "Open business bank account (yes/no)" },
      bank_provider: { type: "string", description: "Bank: mercury, relay, bluevine" },
      member_name: { type: "string", description: "Primary member full name" },
      member_email: { type: "string", description: "Primary member email" },
      street: { type: "string", description: "Principal address street" },
      city: { type: "string", description: "City" },
      zip: { type: "string", description: "ZIP code" },
    },
    required: [
      "company_name",
      "entity_type",
      "state",
      "business_purpose",
      "member_name",
      "member_email",
    ],
    handler: handleFormBusiness,
  },
  {
    name: "formation_status",
    description: "Check the status of a business formation in progress.",
    parameters: { entity_id: { type: "string", description: "Entity ID from form_business" } },
    required: ["entity_id"],
    handler: handleFormationStatus,
  },
  {
    name: "list_businesses",
    description: "List all business entities and their compliance status.",
    parameters: {},
    required: [],
    handler: handleListBusinesses,
  },

  // ── Revenue & Business Operations ─────────────────────────────────────────
  {
    name: "record_revenue",
    description:
      "Record real revenue earned by an agent (payment received, deal closed, invoice paid).",
    parameters: {
      agent_id: { type: "string", description: "Agent that generated the revenue" },
      amount_cents: { type: "number", description: "Revenue amount in cents (e.g., 50000 = $500)" },
      source: {
        type: "string",
        description:
          "Source: client_payment, subscription, product_sale, lead_conversion, affiliate, consulting_fee, service_delivery, invoice_paid",
      },
      payer: { type: "string", description: "Who paid (client name or email)" },
      description: { type: "string", description: "What the payment was for" },
    },
    required: ["agent_id", "amount_cents", "source", "payer", "description"],
    handler: handleRecordRevenue,
  },
  {
    name: "business_dashboard",
    description: "Full business health: revenue, clients, pipeline, compliance, agent ROI.",
    parameters: {},
    required: [],
    handler: handleBusinessDashboard,
  },
  {
    name: "create_client",
    description: "Add a new client/customer to the CRM.",
    parameters: {
      name: { type: "string", description: "Client name" },
      email: { type: "string", description: "Client email" },
      company: { type: "string", description: "Client company" },
      source: { type: "string", description: "How they found us" },
      agent_id: { type: "string", description: "Agent that acquired this client" },
    },
    required: ["name", "email", "source"],
    handler: handleCreateClient,
  },
  {
    name: "create_deal",
    description: "Add a deal to the sales pipeline.",
    parameters: {
      client_id: { type: "string", description: "Client ID" },
      agent_id: { type: "string", description: "Agent managing this deal" },
      name: { type: "string", description: "Deal name" },
      value_cents: { type: "number", description: "Deal value in cents" },
      expected_close_date: { type: "string", description: "Expected close date (ISO)" },
    },
    required: ["client_id", "agent_id", "name", "value_cents"],
    handler: handleCreateDeal,
  },
  {
    name: "create_invoice",
    description: "Create an invoice for a client. Agents can auto-send these.",
    parameters: {
      client_id: { type: "string", description: "Client ID" },
      agent_id: { type: "string", description: "Agent creating the invoice" },
      description: { type: "string", description: "Line item description" },
      amount_cents: { type: "number", description: "Amount in cents" },
      due_days: { type: "number", description: "Days until due (default 30)" },
    },
    required: ["client_id", "agent_id", "description", "amount_cents"],
    handler: handleCreateInvoice,
  },
  {
    name: "set_revenue_goal",
    description: "Set a revenue target. I'll track progress and alert you.",
    parameters: {
      target_cents: {
        type: "number",
        description: "Target revenue in cents (e.g., 1000000 = $10,000)",
      },
      period: { type: "string", description: "Period: daily, weekly, monthly, quarterly, annual" },
    },
    required: ["target_cents", "period"],
    handler: handleSetRevenueGoal,
  },
  {
    name: "check_balance",
    description: "Show credit balance, usage, and spending trends.",
    parameters: {},
    required: [],
    handler: handleCheckBalance,
  },
];

// ── Agent Handlers ───────────────────────────────────────────────────────────

async function handleCreateAgent(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const spec: AgentSpec = {
    name: params.name as string,
    purpose: params.purpose as string,
    systemPrompt: params.system_prompt as string,
    tools: (params.tools as string[]) ?? ["web_search", "send_message"],
    channels: (params.channels as string[]) ?? [],
    cronSchedule: (params.cron_schedule as string) ?? undefined,
    primaryChannel: ((params.channels as string[]) ?? [])[0] ?? undefined,
    channelTarget: (params.channel_target as string) ?? undefined,
  };

  const agent = spawnAgent(orgId, spec);
  const revenueTarget = params.revenue_target_cents as number | undefined;

  const lines = [
    `Agent deployed and running:`,
    `- **ID**: ${agent.id}`,
    `- **Name**: ${agent.name}`,
    `- **Purpose**: ${spec.purpose}`,
    `- **Tools**: ${spec.tools.join(", ")}`,
    `- **Channels**: ${spec.channels.join(", ") || "reactive via master"}`,
  ];
  if (agent.cronJobId) {
    lines.push(`- **Schedule**: ${spec.cronSchedule}`);
  }
  if (revenueTarget) {
    lines.push(`- **Revenue target**: $${(revenueTarget / 100).toFixed(2)}/month`);
  }
  lines.push(`- **Est. run cost**: ~$0.08-0.20`);
  return lines.join("\n");
}

async function handleListAgents(orgId: OrgId): Promise<string> {
  const agents = listOrgAgents(orgId);
  if (agents.length === 0) {
    return "No agents deployed. Tell me what your business needs and I'll build the agents to run it.";
  }

  const lines = [`**${agents.length} agent(s) running:**\n`];
  for (const agent of agents) {
    const rev = getAgentRevenue(agent.id);
    const status = agent.status === "active" ? "running" : agent.status;
    const costCents = agent.metrics.totalCostCents;
    const roi = costCents > 0 ? ((rev.totalCents / costCents) * 100).toFixed(0) : "N/A";

    lines.push(
      `**${agent.name}** (${agent.id}) — ${status}`,
      `  Purpose: ${agent.spec.purpose}`,
      `  Revenue: $${(rev.totalCents / 100).toFixed(2)} | Cost: $${(costCents / 100).toFixed(2)} | ROI: ${roi}%`,
      `  Runs: ${agent.metrics.totalRuns} | Last: ${agent.metrics.lastRunAt?.toISOString().slice(0, 10) ?? "never"}`,
      "",
    );
  }
  return lines.join("\n");
}

async function handleStopAgent(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const agentId = params.agent_id as string;
  const agent = getAgentStatus(agentId);
  if (!agent || agent.orgId !== orgId) {
    return `Agent ${agentId} not found.`;
  }
  destroyAgent(agentId);
  return `Agent **${agent.name}** stopped and removed.`;
}

async function handleModifyAgent(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const agentId = params.agent_id as string;
  const agent = getAgentStatus(agentId);
  if (!agent || agent.orgId !== orgId) {
    return `Agent ${agentId} not found.`;
  }

  const changes: Partial<AgentSpec> = {};
  if (params.system_prompt) {
    changes.systemPrompt = params.system_prompt as string;
  }
  if (params.cron_schedule) {
    changes.cronSchedule =
      params.cron_schedule === "none" ? undefined : (params.cron_schedule as string);
  }
  if (params.tools) {
    changes.tools = params.tools as string[];
  }
  if (params.channels) {
    changes.channels = params.channels as string[];
  }

  modifyAgent(agentId, changes);
  return `Agent **${agent.name}** updated.`;
}

async function handleAgentMetrics(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const agentId = params.agent_id as string;
  const agent = getAgentStatus(agentId);
  if (!agent || agent.orgId !== orgId) {
    return `Agent ${agentId} not found.`;
  }

  const m = agent.metrics;
  const rev = getAgentRevenue(agentId);
  const roi = m.totalCostCents > 0 ? ((rev.totalCents / m.totalCostCents) * 100).toFixed(0) : "N/A";

  return [
    `**${agent.name}** (${agent.id})`,
    `Status: ${agent.status} | Purpose: ${agent.spec.purpose}`,
    "",
    "**Revenue:**",
    `  Total earned: $${(rev.totalCents / 100).toFixed(2)}`,
    `  Last 30 days: $${(rev.last30DaysCents / 100).toFixed(2)}`,
    `  Transactions: ${rev.transactionCount}`,
    "",
    "**Performance:**",
    `  Runs: ${m.totalRuns} (${m.successfulRuns} ok, ${m.failedRuns} failed)`,
    `  Messages: ${m.totalMessagesHandled}`,
    `  Cost: $${(m.totalCostCents / 100).toFixed(2)}`,
    `  **ROI: ${roi}%**`,
    "",
    `  Last run: ${m.lastRunAt?.toISOString() ?? "never"}`,
  ].join("\n");
}

// ── Formation Handlers ───────────────────────────────────────────────────────

async function handleFormBusiness(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const entityType = params.entity_type as EntityType;
  const state = params.state as USState;
  const requestEin = (params.request_ein as string) !== "no";
  const openBank = (params.open_bank_account as string) === "yes";

  // Show cost estimate first
  const estimate = estimateFormationCost(entityType, state, {
    registeredAgent: true,
    bankAccount: openBank,
    einApplication: requestEin,
  });

  const entity = startFormation(orgId, {
    businessPurpose: params.business_purpose as string,
    entityType,
    state,
    companyName: params.company_name as string,
    registeredAgentService: "included",
    principalAddress: {
      street1: (params.street as string) ?? "TBD",
      city: (params.city as string) ?? "TBD",
      state,
      zip: (params.zip as string) ?? "00000",
      country: "US",
    },
    members: [
      {
        name: params.member_name as string,
        email: params.member_email as string,
        role: "member",
        ownershipPercent: 100,
        address: {
          street1: (params.street as string) ?? "TBD",
          city: (params.city as string) ?? "TBD",
          state,
          zip: (params.zip as string) ?? "00000",
          country: "US",
        },
      },
    ],
    requestEin,
    openBankAccount: openBank,
    bankProvider: (params.bank_provider as "mercury" | "relay" | "bluevine") ?? undefined,
  });

  const lines = [
    `**Business formation started!**`,
    `- **Entity**: ${entity.companyName}`,
    `- **Type**: ${entityType.toUpperCase()}`,
    `- **State**: ${state}`,
    `- **Entity ID**: ${entity.id}`,
    "",
    "**Cost breakdown:**",
    ...estimate.breakdown,
    "",
    "**Steps in progress:**",
    ...entity.steps.map(
      (s) =>
        `  ${s.status === "completed" ? "done" : s.status === "requires_action" ? "ACTION NEEDED" : "pending"} — ${s.step.replace(/_/g, " ")}`,
    ),
    "",
    `Use \`formation_status\` with entity ID to check progress.`,
  ];
  return lines.join("\n");
}

async function handleFormationStatus(
  orgId: OrgId,
  params: Record<string, unknown>,
): Promise<string> {
  const entityId = params.entity_id as string;
  const entity = getFormationStatus(entityId);
  if (!entity || entity.orgId !== orgId) {
    return `Entity ${entityId} not found.`;
  }

  const lines = [
    `**${entity.companyName}** — ${entity.status.toUpperCase()}`,
    `Type: ${entity.entityType.toUpperCase()} | State: ${entity.state}`,
    entity.ein ? `EIN: ${entity.ein}` : "",
    entity.stateFileNumber ? `State file #: ${entity.stateFileNumber}` : "",
    "",
    "**Steps:**",
    ...entity.steps.map((s) => {
      const icon =
        s.status === "completed"
          ? "[done]"
          : s.status === "failed"
            ? "[FAILED]"
            : s.status === "requires_action"
              ? "[ACTION]"
              : "[...]";
      let line = `  ${icon} ${s.step.replace(/_/g, " ")}`;
      if (s.actionRequired) {
        line += ` — ${s.actionRequired}`;
      }
      if (s.error) {
        line += ` — ERROR: ${s.error}`;
      }
      return line;
    }),
  ].filter(Boolean);

  if (entity.complianceCalendar.length > 0) {
    lines.push("", "**Upcoming compliance:**");
    for (const c of entity.complianceCalendar.slice(0, 5)) {
      lines.push(`  ${c.dueDate.toISOString().slice(0, 10)} — ${c.name}`);
    }
  }

  return lines.join("\n");
}

async function handleListBusinesses(orgId: OrgId): Promise<string> {
  const entities = listOrgEntities(orgId);
  if (entities.length === 0) {
    return "No business entities. Say 'form my LLC in Wyoming' to get started.";
  }

  const compliance = getUpcomingCompliance(orgId, 60);
  const lines = [`**${entities.length} business(es):**\n`];

  for (const e of entities) {
    lines.push(
      `**${e.companyName}** (${e.entityType.toUpperCase()}, ${e.state})`,
      `  Status: ${e.status} | ID: ${e.id}`,
      e.ein ? `  EIN: ${e.ein}` : "",
      "",
    );
  }

  if (compliance.length > 0) {
    lines.push("**Upcoming compliance deadlines:**");
    for (const c of compliance.slice(0, 5)) {
      lines.push(`  ${c.dueDate.toISOString().slice(0, 10)} — ${c.name} (${c.status})`);
    }
  }

  return lines.filter(Boolean).join("\n");
}

// ── Revenue Handlers ─────────────────────────────────────────────────────────

async function handleRecordRevenue(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const event = recordRevenue({
    orgId,
    agentId: params.agent_id as string,
    source: params.source as RevenueSource,
    amountCents: params.amount_cents as number,
    payer: params.payer as string,
    description: params.description as string,
  });

  return [
    `**Revenue recorded!**`,
    `  Amount: $${(event.amountCents / 100).toFixed(2)}`,
    `  Source: ${event.source.replace(/_/g, " ")}`,
    `  Payer: ${event.payer}`,
    `  Agent: ${event.agentId}`,
    `  ID: ${event.id}`,
  ].join("\n");
}

async function handleBusinessDashboard(orgId: OrgId): Promise<string> {
  const health = getBusinessHealth(orgId);
  const balance = getBalance(orgId);
  const usage = getUsageSummary(orgId);
  const pipeline = getPipelineValue(orgId);
  const entities = listOrgEntities(orgId);
  const compliance = getUpcomingCompliance(orgId, 30);

  const lines = [
    "## Business Dashboard",
    "",
    "**Revenue:**",
    `  Today: $${(health.revenueToday / 100).toFixed(2)}`,
    `  7 days: $${(health.revenue7d / 100).toFixed(2)}`,
    `  30 days: $${(health.revenue30d / 100).toFixed(2)}`,
    "",
    "**Clients:**",
    `  Active: ${health.activeClients} | Total: ${health.totalClients}`,
    "",
    "**Pipeline:**",
    `  Open deals: ${health.openDeals} ($${(health.pipelineValue / 100).toFixed(2)})`,
    `  Weighted value: $${(pipeline.weightedValueCents / 100).toFixed(2)}`,
    "",
    "**Invoices:**",
    `  Unpaid: ${health.unpaidInvoices} ($${(health.unpaidInvoiceValue / 100).toFixed(2)})`,
    "",
    "**Platform Credits:**",
    `  Balance: $${(balance.balanceCents / 100).toFixed(2)}${balance.lowBalance ? " (LOW)" : ""}`,
    `  Agent costs this month: $${(usage.totalCostCents / 100).toFixed(2)}`,
    "",
    `**Entities:** ${entities.length} business(es)`,
  ];

  if (health.topAgent) {
    lines.push(
      `**Top agent:** ${health.topAgent.agentId} — $${(health.topAgent.revenueCents / 100).toFixed(2)} revenue (30d)`,
    );
  }

  if (health.goals.length > 0) {
    lines.push("", "**Revenue Goals:**");
    for (const g of health.goals) {
      const pct =
        g.targetAmountCents > 0
          ? ((g.currentAmountCents / g.targetAmountCents) * 100).toFixed(0)
          : "0";
      lines.push(
        `  ${g.period}: $${(g.currentAmountCents / 100).toFixed(2)} / $${(g.targetAmountCents / 100).toFixed(2)} (${pct}%) — ${g.status.replace(/_/g, " ")}`,
      );
    }
  }

  if (compliance.length > 0) {
    lines.push("", "**Upcoming Compliance:**");
    for (const c of compliance.slice(0, 3)) {
      lines.push(`  ${c.dueDate.toISOString().slice(0, 10)} — ${c.name}`);
    }
  }

  return lines.join("\n");
}

async function handleCreateClient(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const client = createClient({
    orgId,
    name: params.name as string,
    email: params.email as string,
    company: params.company as string | undefined,
    source: params.source as string,
    acquiredByAgentId: params.agent_id as string | undefined,
  });
  return `Client added: **${client.name}** (${client.id}) — ${client.email}`;
}

async function handleCreateDeal(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const deal = createDeal({
    orgId,
    clientId: params.client_id as string,
    agentId: params.agent_id as string,
    name: params.name as string,
    valueCents: params.value_cents as number,
    expectedCloseDate: params.expected_close_date
      ? new Date(params.expected_close_date as string)
      : new Date(Date.now() + 30 * 86_400_000),
  });
  return `Deal created: **${deal.name}** — $${(deal.valueCents / 100).toFixed(2)} (${deal.stage}) ID: ${deal.id}`;
}

async function handleCreateInvoice(orgId: OrgId, params: Record<string, unknown>): Promise<string> {
  const dueDays = (params.due_days as number) ?? 30;
  const invoice = createInvoice({
    orgId,
    clientId: params.client_id as string,
    agentId: params.agent_id as string,
    lineItems: [
      {
        description: params.description as string,
        quantity: 1,
        unitPriceCents: params.amount_cents as number,
        totalCents: params.amount_cents as number,
      },
    ],
    dueDate: new Date(Date.now() + dueDays * 86_400_000),
  });
  return `Invoice created: **${invoice.id}** — $${(invoice.totalCents / 100).toFixed(2)} due ${invoice.dueDate.toISOString().slice(0, 10)}`;
}

async function handleSetRevenueGoal(
  orgId: OrgId,
  params: Record<string, unknown>,
): Promise<string> {
  const goal = setRevenueGoal({
    orgId,
    targetAmountCents: params.target_cents as number,
    period: params.period as "daily" | "weekly" | "monthly" | "quarterly" | "annual",
  });
  return `Revenue goal set: **$${(goal.targetAmountCents / 100).toFixed(2)}** per ${goal.period} (${goal.startDate.toISOString().slice(0, 10)} to ${goal.endDate.toISOString().slice(0, 10)})`;
}

async function handleCheckBalance(orgId: OrgId): Promise<string> {
  const balance = getBalance(orgId);
  const usage = getUsageSummary(orgId);
  const daily = getDailyUsage(orgId, 7);
  const recentTx = getTransactionHistory(orgId, 5);

  const lines = [
    `**Credit Balance**: $${(balance.balanceCents / 100).toFixed(2)}${balance.lowBalance ? " (LOW)" : ""}`,
    `**This month's agent costs**: $${(usage.totalCostCents / 100).toFixed(2)}`,
    "",
    "**Last 7 days:**",
    ...daily.map((d) => `  ${d.date}: $${(d.costCents / 100).toFixed(2)} (${d.events} events)`),
    "",
    "**Recent transactions:**",
    ...recentTx.map(
      (tx) =>
        `  ${tx.type === "credit" ? "+" : "-"}$${(tx.amountCents / 100).toFixed(2)} — ${tx.description}`,
    ),
  ];

  if (balance.lowBalance) {
    lines.push("", "Add credits to keep your agents running and generating revenue.");
  }

  return lines.join("\n");
}
