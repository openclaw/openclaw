/**
 * Master Agent — The OS Brain
 *
 * The platform IS this agent. Users talk to it, it creates and manages
 * sub-agents on the fly. It understands business needs and translates
 * them into running autonomous agents.
 *
 * This module defines the master agent's system prompt and tool definitions
 * that integrate with OpenClaw's existing tool system.
 */

import type { OrgId } from "../tenants/types.js";
import type { AgentSpec, DeployedAgent } from "./agent-spawner.js";
import {
	destroyAgent,
	executeAgentRun,
	getAgentStatus,
	listOrgAgents,
	modifyAgent,
	spawnAgent,
} from "./agent-spawner.js";
import { getBalance, getTransactionHistory } from "../billing/credits.js";
import { getDailyUsage, getUsageSummary } from "../billing/usage-meter.js";

// ── Master Agent System Prompt ───────────────────────────────────────────────

export const MASTER_AGENT_SYSTEM_PROMPT = `You are an AI Operating System that runs businesses autonomously.

When users describe what they need, you create, manage, and monitor autonomous AI agents that handle it for them. You don't just answer questions — you build living systems that work 24/7.

## What You Can Do

- **Create agents** that run on schedule or react to messages across any channel
- **Monitor agents** — check their performance, costs, and health
- **Modify agents** — update behavior, schedules, channels, or tools
- **Manage billing** — show credit balance, usage, and costs

## How You Work

When a user says something like:
- "Handle my customer support on Telegram" → You create a support agent, wire it to Telegram, give it their knowledge base context, and start it running
- "Post to LinkedIn every morning at 8am" → You create a content agent with a cron schedule, configure it for LinkedIn-style content in their brand voice
- "Monitor my website and alert me on Slack if it goes down" → You create an ops agent with a 5-minute health check cron, wired to Slack for alerts
- "Research my competitors weekly" → You create a research agent with web search tools on a weekly cron
- "Follow up with leads every 3 days" → You create a sales agent with follow-up scheduling

## Rules

1. **Always confirm before creating an agent.** Show what you'll build and the estimated cost.
2. **Be specific about what the agent will do.** Don't create vague agents.
3. **Show costs transparently.** Every agent run costs credits.
4. **Monitor proactively.** If an agent is failing or burning credits, alert the user.
5. **One agent per concern.** Don't overload a single agent with unrelated tasks.

## Estimated Costs (per run)
- Simple agent run (check + respond): ~$0.08
- Agent run with web search: ~$0.12
- Agent run with image generation: ~$0.15
- Complex multi-tool run: ~$0.20-0.50

Credits are prepaid. When balance is low, you warn the user. When zero, agents pause.`;

// ── Master Agent Tool Definitions ────────────────────────────────────────────

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

export const MASTER_AGENT_TOOLS: MasterAgentTool[] = [
	{
		name: "create_agent",
		description:
			"Create and deploy a new autonomous agent. The agent will run on its own schedule and deliver results to the specified channel.",
		parameters: {
			name: { type: "string", description: "Human-readable name for the agent" },
			purpose: {
				type: "string",
				description: "What this agent does (e.g., 'customer support', 'lead follow-up')",
			},
			system_prompt: {
				type: "string",
				description: "Detailed instructions for how the agent should behave",
			},
			tools: {
				type: "array",
				description:
					"Tools the agent can use: web_search, send_message, image_generate, http_request, calendar, email",
				items: { type: "string" },
			},
			channels: {
				type: "array",
				description:
					"Channels the agent operates on: whatsapp, telegram, slack, discord, email, webchat",
				items: { type: "string" },
			},
			cron_schedule: {
				type: "string",
				description:
					"Cron expression for scheduled runs (e.g., '0 9 * * 1-5' for weekdays at 9am). Omit for reactive-only agents.",
			},
			channel_target: {
				type: "string",
				description: "Default delivery target (chat ID, channel name, email, etc.)",
			},
		},
		required: ["name", "purpose", "system_prompt"],
		handler: handleCreateAgent,
	},
	{
		name: "list_agents",
		description:
			"List all agents for this organization with their current status and recent metrics.",
		parameters: {},
		required: [],
		handler: handleListAgents,
	},
	{
		name: "stop_agent",
		description: "Stop a running agent. It will no longer execute on its schedule or react to messages.",
		parameters: {
			agent_id: { type: "string", description: "The ID of the agent to stop" },
		},
		required: ["agent_id"],
		handler: handleStopAgent,
	},
	{
		name: "modify_agent",
		description: "Update an agent's behavior, schedule, channels, or tools.",
		parameters: {
			agent_id: { type: "string", description: "The ID of the agent to modify" },
			system_prompt: { type: "string", description: "New system prompt (replaces existing)" },
			cron_schedule: {
				type: "string",
				description: "New cron schedule (or 'none' to make reactive-only)",
			},
			tools: {
				type: "array",
				description: "New tool list",
				items: { type: "string" },
			},
			channels: {
				type: "array",
				description: "New channel list",
				items: { type: "string" },
			},
		},
		required: ["agent_id"],
		handler: handleModifyAgent,
	},
	{
		name: "check_balance",
		description: "Show the organization's credit balance, recent usage, and spending trends.",
		parameters: {},
		required: [],
		handler: handleCheckBalance,
	},
	{
		name: "agent_metrics",
		description: "Show detailed performance metrics for a specific agent.",
		parameters: {
			agent_id: { type: "string", description: "The ID of the agent to inspect" },
		},
		required: ["agent_id"],
		handler: handleAgentMetrics,
	},
];

// ── Tool Handlers ────────────────────────────────────────────────────────────

async function handleCreateAgent(
	orgId: OrgId,
	params: Record<string, unknown>,
): Promise<string> {
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

	const lines = [
		`Agent created and deployed:`,
		`- **ID**: ${agent.id}`,
		`- **Name**: ${agent.name}`,
		`- **Status**: ${agent.status}`,
		`- **Tools**: ${agent.spec.tools.join(", ")}`,
		`- **Channels**: ${agent.spec.channels.join(", ") || "none (reactive via master)"}`,
	];
	if (agent.cronJobId) {
		lines.push(`- **Schedule**: ${agent.spec.cronSchedule} (cron job: ${agent.cronJobId})`);
	}
	lines.push(`- **Estimated cost per run**: ~$0.08-0.20`);

	return lines.join("\n");
}

async function handleListAgents(orgId: OrgId): Promise<string> {
	const agents = listOrgAgents(orgId);
	if (agents.length === 0) {
		return "No agents deployed yet. Describe what you need and I'll create one.";
	}

	const lines = [`**${agents.length} agent(s) deployed:**\n`];
	for (const agent of agents) {
		const status = agent.status === "active" ? "running" : agent.status;
		lines.push(
			`- **${agent.name}** (${agent.id}) — ${status}`,
			`  Purpose: ${agent.spec.purpose}`,
			`  Runs: ${agent.metrics.totalRuns} | Cost: $${(agent.metrics.totalCostCents / 100).toFixed(2)}`,
			"",
		);
	}
	return lines.join("\n");
}

async function handleStopAgent(
	orgId: OrgId,
	params: Record<string, unknown>,
): Promise<string> {
	const agentId = params.agent_id as string;
	const agent = getAgentStatus(agentId);
	if (!agent || agent.orgId !== orgId) {
		return `Agent ${agentId} not found.`;
	}

	destroyAgent(agentId);
	return `Agent **${agent.name}** (${agentId}) has been stopped and removed.`;
}

async function handleModifyAgent(
	orgId: OrgId,
	params: Record<string, unknown>,
): Promise<string> {
	const agentId = params.agent_id as string;
	const agent = getAgentStatus(agentId);
	if (!agent || agent.orgId !== orgId) {
		return `Agent ${agentId} not found.`;
	}

	const changes: Partial<AgentSpec> = {};
	if (params.system_prompt) changes.systemPrompt = params.system_prompt as string;
	if (params.cron_schedule) {
		changes.cronSchedule = params.cron_schedule === "none" ? undefined : (params.cron_schedule as string);
	}
	if (params.tools) changes.tools = params.tools as string[];
	if (params.channels) changes.channels = params.channels as string[];

	modifyAgent(agentId, changes);
	return `Agent **${agent.name}** updated successfully.`;
}

async function handleCheckBalance(orgId: OrgId): Promise<string> {
	const balance = getBalance(orgId);
	const usage = getUsageSummary(orgId);
	const daily = getDailyUsage(orgId, 7);
	const recentTx = getTransactionHistory(orgId, 5);

	const lines = [
		`**Credit Balance**: $${(balance.balanceCents / 100).toFixed(2)}${balance.lowBalance ? " (LOW)" : ""}`,
		`**This month's usage**: $${(usage.totalCostCents / 100).toFixed(2)}`,
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
		lines.push("", "Add credits to keep your agents running.");
	}

	return lines.join("\n");
}

async function handleAgentMetrics(
	orgId: OrgId,
	params: Record<string, unknown>,
): Promise<string> {
	const agentId = params.agent_id as string;
	const agent = getAgentStatus(agentId);
	if (!agent || agent.orgId !== orgId) {
		return `Agent ${agentId} not found.`;
	}

	const m = agent.metrics;
	return [
		`**Agent: ${agent.name}** (${agent.id})`,
		`Status: ${agent.status}`,
		`Purpose: ${agent.spec.purpose}`,
		"",
		"**Performance:**",
		`  Total runs: ${m.totalRuns}`,
		`  Successful: ${m.successfulRuns}`,
		`  Failed: ${m.failedRuns}`,
		`  Success rate: ${m.totalRuns > 0 ? ((m.successfulRuns / m.totalRuns) * 100).toFixed(1) : 0}%`,
		"",
		"**Usage:**",
		`  Tokens used: ${m.totalTokensUsed.toLocaleString()}`,
		`  Messages handled: ${m.totalMessagesHandled}`,
		`  Total cost: $${(m.totalCostCents / 100).toFixed(2)}`,
		`  Avg cost/run: $${m.totalRuns > 0 ? ((m.totalCostCents / m.totalRuns) / 100).toFixed(3) : "0.00"}`,
		"",
		`  Last run: ${m.lastRunAt?.toISOString() ?? "never"}`,
	].join("\n");
}
