/**
 * Business Formation Types
 *
 * Automated business entity creation: LLC formation, EIN acquisition,
 * registered agent setup, bank account opening, and compliance tracking.
 *
 * The Master Agent uses these to help users incorporate businesses
 * that their revenue-generating agents will operate.
 */

import type { OrgId } from "../tenants/types.js";

// ── Entity Types ─────────────────────────────────────────────────────────────

export const ENTITY_TYPES = ["llc", "s_corp", "c_corp", "sole_prop", "dba"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const FORMATION_STATES = [
	"AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
	"HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
	"MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
	"NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
	"SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;
export type USState = (typeof FORMATION_STATES)[number];

// ── Formation Request ────────────────────────────────────────────────────────

export interface FormationRequest {
	/** What the business does — feeds into Articles of Organization */
	businessPurpose: string;
	entityType: EntityType;
	state: USState;
	companyName: string;
	/** Alternate names if primary is taken */
	alternateNames?: string[];
	registeredAgentService: "included" | "own";
	/** Principal address */
	principalAddress: PhysicalAddress;
	members: EntityMember[];
	/** Request EIN from IRS automatically */
	requestEin: boolean;
	/** Open a business bank account via integrated provider */
	openBankAccount: boolean;
	bankProvider?: "mercury" | "relay" | "bluevine";
}

export interface EntityMember {
	name: string;
	email: string;
	role: "member" | "manager" | "registered_agent";
	ownershipPercent: number;
	address: PhysicalAddress;
	ssn?: string; // encrypted at rest, needed for EIN
}

export interface PhysicalAddress {
	street1: string;
	street2?: string;
	city: string;
	state: USState;
	zip: string;
	country: string;
}

// ── Formation Status ─────────────────────────────────────────────────────────

export const FORMATION_STEP_STATUS = [
	"pending",
	"in_progress",
	"completed",
	"failed",
	"requires_action",
] as const;
export type StepStatus = (typeof FORMATION_STEP_STATUS)[number];

export interface FormationStep {
	step: FormationStepName;
	status: StepStatus;
	startedAt?: Date;
	completedAt?: Date;
	error?: string;
	/** External reference (filing number, EIN, account number, etc.) */
	externalRef?: string;
	/** If requires_action, what the user needs to do */
	actionRequired?: string;
}

export const FORMATION_STEPS = [
	"name_availability_check",
	"articles_of_organization",
	"state_filing",
	"operating_agreement",
	"ein_application",
	"registered_agent_setup",
	"bank_account_opening",
	"compliance_calendar_setup",
] as const;
export type FormationStepName = (typeof FORMATION_STEPS)[number];

// ── Business Entity (the result) ─────────────────────────────────────────────

export interface BusinessEntity {
	id: string;
	orgId: OrgId;
	companyName: string;
	entityType: EntityType;
	state: USState;
	status: "forming" | "active" | "suspended" | "dissolved";
	ein?: string;
	stateFileNumber?: string;
	formationDate?: Date;
	steps: FormationStep[];
	bankAccount?: BankAccountInfo;
	complianceCalendar: ComplianceEvent[];
	createdAt: Date;
	updatedAt: Date;
}

export interface BankAccountInfo {
	provider: string;
	accountId: string;
	routingNumber?: string;
	status: "pending" | "open" | "frozen" | "closed";
	openedAt?: Date;
}

// ── Compliance ───────────────────────────────────────────────────────────────

export interface ComplianceEvent {
	id: string;
	entityId: string;
	name: string;
	description: string;
	dueDate: Date;
	recurring: boolean;
	/** Cron for recurring (e.g., annual report) */
	recurrenceCron?: string;
	status: "upcoming" | "due_soon" | "overdue" | "completed";
	/** Agent ID assigned to handle this compliance event */
	assignedAgentId?: string;
}

// ── State Filing Fees (approximate, varies by state) ─────────────────────────

export const STATE_FILING_FEES: Partial<Record<USState, Record<EntityType, number>>> = {
	WY: { llc: 100, s_corp: 100, c_corp: 100, sole_prop: 0, dba: 0 },
	DE: { llc: 90, s_corp: 89, c_corp: 89, sole_prop: 0, dba: 0 },
	NV: { llc: 75, s_corp: 75, c_corp: 75, sole_prop: 0, dba: 0 },
	FL: { llc: 125, s_corp: 70, c_corp: 70, sole_prop: 0, dba: 50 },
	TX: { llc: 300, s_corp: 300, c_corp: 300, sole_prop: 0, dba: 0 },
	CA: { llc: 70, s_corp: 100, c_corp: 100, sole_prop: 0, dba: 0 },
	NY: { llc: 200, s_corp: 125, c_corp: 125, sole_prop: 0, dba: 25 },
};

/** Our service fee on top of state filing fees (cents) */
export const FORMATION_SERVICE_FEE_CENTS: Record<EntityType, number> = {
	llc: 9900, // $99
	s_corp: 14900, // $149
	c_corp: 14900, // $149
	sole_prop: 0, // free (no formation needed)
	dba: 4900, // $49
};

/** Annual registered agent service fee (cents) */
export const REGISTERED_AGENT_ANNUAL_FEE_CENTS = 9900; // $99/year
