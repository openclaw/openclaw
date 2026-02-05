/**
 * Multi-tenant Context Manager
 *
 * Extracts tenant context from OpenClaw sessions and maintains
 * security isolation between organizations, workspaces, and teams.
 */

import type { TenantContext } from './types.js';
import type { SessionEntry } from '../config/sessions/types.js';
import { readSessionEntry, updateSessionEntry } from '../config/sessions/store.js';

export class MCPContextManager {
  /**
   * Extract tenant context from a session key
   *
   * Looks up the session in OpenClaw's session store and extracts
   * multi-tenant identifiers (organizationId, workspaceId, teamId, userId).
   *
   * @param sessionKey - OpenClaw session key
   * @returns TenantContext or null if session not found or missing tenant data
   */
  async extractFromSession(sessionKey?: string): Promise<TenantContext> {
    if (!sessionKey) {
      throw new Error('Session key required for multi-tenant MCP access');
    }

    // Load session from store
    const sessionEntry = await readSessionEntry(sessionKey);
    if (!sessionEntry) {
      throw new Error(`Session not found: ${sessionKey}`);
    }

    // Extract tenant context from session
    const context = this.extractFromSessionEntry(sessionEntry);
    if (!context) {
      throw new Error(
        `Multi-tenant context not configured for session: ${sessionKey}. ` +
        `Please set organizationId and workspaceId in session metadata.`
      );
    }

    return context;
  }

  /**
   * Extract tenant context from a SessionEntry
   *
   * This function looks for org/workspace/team/user IDs in the session entry
   * and constructs a TenantContext for MCP credential lookup.
   */
  extractFromSessionEntry(session: SessionEntry): TenantContext | null {
    const organizationId = session.organizationId;
    const workspaceId = session.workspaceId;
    const teamId = session.teamId;
    const userId = session.userId;

    // Organization and workspace are required for multi-tenant mode
    if (!organizationId || !workspaceId) {
      return null;
    }

    return {
      organizationId,
      workspaceId,
      teamId,
      userId,
    };
  }

  /**
   * Store tenant context in a session
   *
   * Updates the session store to include tenant identifiers
   * for future MCP credential lookups.
   *
   * @param sessionKey - OpenClaw session key
   * @param context - Tenant context to store
   */
  async storeInSession(sessionKey: string, context: TenantContext): Promise<void> {
    if (!this.validateTenantContext(context)) {
      throw new Error('Invalid tenant context');
    }

    await updateSessionEntry(sessionKey, {
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      teamId: context.teamId,
      userId: context.userId,
    });
  }

  /**
   * Validate tenant context for security
   *
   * Ensures that the context is well-formed and doesn't contain
   * injection attempts or invalid characters.
   */
  validateTenantContext(context: TenantContext): boolean {
    // Check for required fields
    if (!context.organizationId || !context.workspaceId || !context.userId) {
      return false;
    }

    // Validate format (alphanumeric, dashes, underscores only)
    const validPattern = /^[a-zA-Z0-9_-]+$/;

    if (!validPattern.test(context.organizationId)) {
      return false;
    }

    if (!validPattern.test(context.workspaceId)) {
      return false;
    }

    if (!validPattern.test(context.userId)) {
      return false;
    }

    if (context.teamId && !validPattern.test(context.teamId)) {
      return false;
    }

    // Check length limits
    if (context.organizationId.length > 100) {
      return false;
    }

    if (context.workspaceId.length > 100) {
      return false;
    }

    if (context.userId.length > 100) {
      return false;
    }

    if (context.teamId && context.teamId.length > 100) {
      return false;
    }

    return true;
  }

  /**
   * Create a tenant context from user data
   *
   * This is used when onboarding users from an external system
   * that already has organization/workspace information.
   */
  createFromUserData(data: {
    organizationId: string;
    workspaceId: string;
    userId?: string;
    teamId?: string;
  }): TenantContext {
    const context: TenantContext = {
      organizationId: data.organizationId,
      workspaceId: data.workspaceId,
      userId: data.userId,
      teamId: data.teamId,
    };

    if (!this.validateTenantContext(context)) {
      throw new Error('Invalid tenant context data');
    }

    return context;
  }
}
