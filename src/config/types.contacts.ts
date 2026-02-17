import type { GroupToolPolicyConfig } from "./types.tools.js";

/**
 * A single contact entry in the registry.
 *
 * Contacts are the atomic units — each represents one person with a phone number.
 * Groups reference contacts by their entry key.
 */
export type ContactEntry = {
  /** Phone number in E.164 format (e.g., "+15551234567"). */
  phone: string;
  /** Display name for the contact. */
  name?: string;
  /** Optional email address. */
  email?: string;
  /** Freeform notes (not injected into prompts). */
  notes?: string;
  /**
   * Contact-level tool policy override.
   * Takes precedence over group-level tools.
   */
  tools?: GroupToolPolicyConfig;
};

/**
 * A named group of contacts.
 *
 * Groups enable bulk policy assignment — instead of configuring each contact
 * individually, you define a group with shared permissions.
 */
export type ContactGroup = {
  /**
   * Group members — either entry keys or inline phone numbers.
   *
   * Entry references are resolved from contacts.entries.
   * Inline phones (starting with "+") are used directly.
   *
   * @example ["alice", "bob", "+15559999999"]
   */
  members: string[];
  /**
   * Tool policy applied to all group members.
   * Entry-level tools override this if set.
   */
  tools?: GroupToolPolicyConfig;
  /**
   * Instructions injected into prompt context when sender is in this group.
   * Use for behavioral guidance (e.g., "be casual, no formal scheduling").
   */
  instructions?: string;
};

/**
 * Root contacts configuration.
 *
 * Provides a single source of truth for contact information and group membership.
 * Referenced by toolsBySender via "@groupname" syntax.
 *
 * @example
 * ```yaml
 * contacts:
 *   entries:
 *     alice:
 *       phone: "+15551234567"
 *       name: "Alice Smith"
 *   groups:
 *     friends:
 *       members: [alice]
 *       tools: { allow: ["web_search"] }
 * ```
 */
export type ContactsConfig = {
  /**
   * Named contact entries.
   * Keys are used as references in group members.
   */
  entries?: Record<string, ContactEntry>;
  /**
   * Named groups of contacts.
   * Referenced in toolsBySender as "@groupname".
   */
  groups?: Record<string, ContactGroup>;
};
