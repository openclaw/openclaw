/**
 * Agent Marketplace Types
 *
 * Types for dynamically created agents and the future marketplace
 * where users can share/sell agent configs they've built via chat.
 */

import type { OrgId } from "../tenants/types.js";

// ── Agent Categories ─────────────────────────────────────────────────────────

export const AGENT_CATEGORIES = [
	"sales",
	"support",
	"content",
	"ops",
	"research",
	"custom",
] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

// ── Marketplace Listing (future: user-generated agents shared/sold) ──────────

export interface MarketplaceListing {
	id: string;
	publisherOrgId: OrgId;
	publisherName: string;
	name: string;
	description: string;
	category: AgentCategory;
	/** The agent spec users can one-click deploy */
	agentSpec: {
		systemPrompt: string;
		tools: string[];
		suggestedChannels: string[];
		suggestedCronSchedule?: string;
	};
	tags: string[];
	rating: number;
	reviewCount: number;
	installCount: number;
	/** Price to install (0 = free, otherwise one-time cents) */
	priceCents: number;
	publishedAt: Date;
}

// ── Review ───────────────────────────────────────────────────────────────────

export interface MarketplaceReview {
	id: string;
	listingId: string;
	reviewerOrgId: OrgId;
	rating: number;
	comment: string;
	createdAt: Date;
}
