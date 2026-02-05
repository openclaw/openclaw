/**
 * Batch Operations Service
 *
 * Handles bulk updates to agents - applying presets, templates,
 * and configuration changes across multiple agents.
 */

import { query, queryOne, queryMany } from '../db/client.js';
import {
  listAgentsForCustomer,
  updateAgent,
  type Agent,
  type UpdateAgentInput,
} from '../db/repositories/agent-repository.js';
import {
  getAgentTemplate,
  getSoulPreset,
  syncAgentSkills,
  type AgentTemplate,
  type SoulPreset,
} from '../db/repositories/preset-repository.js';
import { publishAgentCommand } from './agent-manager.js';

// ============================================================================
// TYPES
// ============================================================================

export type BatchTargetScope = 'new_agents' | 'existing_agents' | 'all_agents' | 'selected_agents';

export interface BatchOperation {
  id: string;
  customerId: string | null;
  operationType: string;
  targetScope: BatchTargetScope;
  presetType: string | null;
  presetId: string | null;
  changes: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  affectedAgentIds: string[];
  totalAgents: number;
  processedAgents: number;
  failedAgents: number;
  errors: Array<{ agentId: string; error: string }>;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface ApplyPresetOptions {
  customerId: string;
  targetScope: BatchTargetScope;
  selectedAgentIds?: string[];
  presetType: 'template' | 'soul' | 'skill';
  presetId: string;
  applySkills?: boolean;
  restartRunning?: boolean;
}

export interface BatchUpdateOptions {
  customerId: string;
  targetScope: BatchTargetScope;
  selectedAgentIds?: string[];
  changes: UpdateAgentInput;
  restartRunning?: boolean;
}

// ============================================================================
// BATCH OPERATION TRACKING
// ============================================================================

async function createBatchOperation(input: {
  customerId: string;
  operationType: string;
  targetScope: BatchTargetScope;
  presetType?: string;
  presetId?: string;
  changes: Record<string, unknown>;
}): Promise<string> {
  const result = await queryOne(
    `INSERT INTO batch_operations (
      customer_id, operation_type, target_scope, preset_type, preset_id, changes
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id`,
    [
      input.customerId,
      input.operationType,
      input.targetScope,
      input.presetType || null,
      input.presetId || null,
      JSON.stringify(input.changes),
    ]
  );
  return result!.id as string;
}

async function updateBatchOperation(
  id: string,
  updates: Partial<{
    status: BatchOperation['status'];
    affectedAgentIds: string[];
    totalAgents: number;
    processedAgents: number;
    failedAgents: number;
    errors: Array<{ agentId: string; error: string }>;
    startedAt: Date;
    completedAt: Date;
  }>
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(updates.status);
  }
  if (updates.affectedAgentIds !== undefined) {
    sets.push(`affected_agent_ids = $${idx++}`);
    params.push(updates.affectedAgentIds);
  }
  if (updates.totalAgents !== undefined) {
    sets.push(`total_agents = $${idx++}`);
    params.push(updates.totalAgents);
  }
  if (updates.processedAgents !== undefined) {
    sets.push(`processed_agents = $${idx++}`);
    params.push(updates.processedAgents);
  }
  if (updates.failedAgents !== undefined) {
    sets.push(`failed_agents = $${idx++}`);
    params.push(updates.failedAgents);
  }
  if (updates.errors !== undefined) {
    sets.push(`errors = $${idx++}`);
    params.push(JSON.stringify(updates.errors));
  }
  if (updates.startedAt !== undefined) {
    sets.push(`started_at = $${idx++}`);
    params.push(updates.startedAt);
  }
  if (updates.completedAt !== undefined) {
    sets.push(`completed_at = $${idx++}`);
    params.push(updates.completedAt);
  }

  if (sets.length > 0) {
    params.push(id);
    await query(`UPDATE batch_operations SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  }
}

export async function getBatchOperation(id: string): Promise<BatchOperation | null> {
  const result = await queryOne(`SELECT * FROM batch_operations WHERE id = $1`, [id]);
  if (!result) return null;

  return {
    id: result.id as string,
    customerId: result.customer_id as string | null,
    operationType: result.operation_type as string,
    targetScope: result.target_scope as BatchTargetScope,
    presetType: result.preset_type as string | null,
    presetId: result.preset_id as string | null,
    changes: result.changes as Record<string, unknown>,
    status: result.status as BatchOperation['status'],
    affectedAgentIds: (result.affected_agent_ids as string[]) || [],
    totalAgents: result.total_agents as number,
    processedAgents: result.processed_agents as number,
    failedAgents: result.failed_agents as number,
    errors: (result.errors as Array<{ agentId: string; error: string }>) || [],
    startedAt: result.started_at ? new Date(result.started_at as string) : null,
    completedAt: result.completed_at ? new Date(result.completed_at as string) : null,
    createdAt: new Date(result.created_at as string),
  };
}

export async function listBatchOperations(
  customerId: string,
  options?: { limit?: number; offset?: number }
): Promise<{ operations: BatchOperation[]; total: number }> {
  const limit = options?.limit || 20;
  const offset = options?.offset || 0;

  const [countResult, results] = await Promise.all([
    queryOne(`SELECT COUNT(*) as count FROM batch_operations WHERE customer_id = $1`, [customerId]),
    queryMany(
      `SELECT * FROM batch_operations WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [customerId, limit, offset]
    ),
  ]);

  return {
    operations: results.map((row) => ({
      id: row.id as string,
      customerId: row.customer_id as string | null,
      operationType: row.operation_type as string,
      targetScope: row.target_scope as BatchTargetScope,
      presetType: row.preset_type as string | null,
      presetId: row.preset_id as string | null,
      changes: row.changes as Record<string, unknown>,
      status: row.status as BatchOperation['status'],
      affectedAgentIds: (row.affected_agent_ids as string[]) || [],
      totalAgents: row.total_agents as number,
      processedAgents: row.processed_agents as number,
      failedAgents: row.failed_agents as number,
      errors: (row.errors as Array<{ agentId: string; error: string }>) || [],
      startedAt: row.started_at ? new Date(row.started_at as string) : null,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
      createdAt: new Date(row.created_at as string),
    })),
    total: parseInt((countResult?.count as string) || '0', 10),
  };
}

// ============================================================================
// GET TARGET AGENTS
// ============================================================================

async function getTargetAgents(
  customerId: string,
  targetScope: BatchTargetScope,
  selectedAgentIds?: string[]
): Promise<Agent[]> {
  switch (targetScope) {
    case 'new_agents':
      // For new_agents, we save the config but don't update existing agents
      // Return empty array - the preset will be applied via defaults
      return [];

    case 'existing_agents': {
      const result = await listAgentsForCustomer(customerId, { limit: 1000 });
      return result.agents;
    }

    case 'all_agents': {
      const result = await listAgentsForCustomer(customerId, { limit: 1000 });
      return result.agents;
    }

    case 'selected_agents': {
      if (!selectedAgentIds || selectedAgentIds.length === 0) {
        return [];
      }
      const result = await listAgentsForCustomer(customerId, { limit: 1000 });
      return result.agents.filter((a) => selectedAgentIds.includes(a.id));
    }

    default:
      return [];
  }
}

// ============================================================================
// APPLY TEMPLATE
// ============================================================================

export async function applyTemplateToAgents(options: ApplyPresetOptions): Promise<BatchOperation> {
  const {
    customerId,
    targetScope,
    selectedAgentIds,
    presetId,
    applySkills = true,
    restartRunning = false,
  } = options;

  // Get the template
  const template = await getAgentTemplate(presetId);
  if (!template) {
    throw new Error('Template not found');
  }

  // Get soul if referenced
  let soul: SoulPreset | null = null;
  if (template.soulPresetId) {
    soul = await getSoulPreset(template.soulPresetId);
  }

  // Build changes object
  const changes: UpdateAgentInput = {
    model: template.model,
    maxTokens: template.maxTokens,
    temperature: template.temperature,
    telegramGroupPolicy: template.telegramGroupPolicy,
    telegramDmPolicy: template.telegramDmPolicy,
  };

  // Apply soul's system prompt if available
  if (soul) {
    changes.systemPrompt = soul.systemPrompt;
  } else if (template.customSystemPrompt) {
    changes.systemPrompt = template.customSystemPrompt;
  }

  // Create batch operation record
  const operationId = await createBatchOperation({
    customerId,
    operationType: 'apply_template',
    targetScope,
    presetType: 'template',
    presetId,
    changes,
  });

  // Get target agents
  const agents = await getTargetAgents(customerId, targetScope, selectedAgentIds);

  // Update operation with agent count
  await updateBatchOperation(operationId, {
    status: 'running',
    totalAgents: agents.length,
    affectedAgentIds: agents.map((a) => a.id),
    startedAt: new Date(),
  });

  // Process agents
  const errors: Array<{ agentId: string; error: string }> = [];
  let processed = 0;
  let failed = 0;

  for (const agent of agents) {
    try {
      // Update agent config
      await updateAgent(agent.id, customerId, changes);

      // Sync skills if requested
      if (applySkills && template.skillPresetIds.length > 0) {
        await syncAgentSkills(agent.id, template.skillPresetIds);
      }

      // Restart if running and requested
      if (restartRunning && agent.status === 'running') {
        await publishAgentCommand(agent.id, 'restart');
      }

      processed++;
    } catch (error) {
      failed++;
      errors.push({
        agentId: agent.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Update progress periodically
    if (processed % 10 === 0) {
      await updateBatchOperation(operationId, {
        processedAgents: processed,
        failedAgents: failed,
        errors,
      });
    }
  }

  // Mark as completed
  await updateBatchOperation(operationId, {
    status: failed > 0 && processed === 0 ? 'failed' : 'completed',
    processedAgents: processed,
    failedAgents: failed,
    errors,
    completedAt: new Date(),
  });

  // Update default template for new agents if scope includes new_agents
  if (targetScope === 'new_agents' || targetScope === 'all_agents') {
    await query(
      `INSERT INTO customer_config (customer_id, key, value)
       VALUES ($1, 'default_template_id', $2)
       ON CONFLICT (customer_id, key) DO UPDATE SET value = $2`,
      [customerId, JSON.stringify(presetId)]
    );
  }

  return (await getBatchOperation(operationId))!;
}

// ============================================================================
// APPLY SOUL
// ============================================================================

export async function applySoulToAgents(options: ApplyPresetOptions): Promise<BatchOperation> {
  const { customerId, targetScope, selectedAgentIds, presetId, restartRunning = false } = options;

  // Get the soul
  const soul = await getSoulPreset(presetId);
  if (!soul) {
    throw new Error('Soul preset not found');
  }

  // Build changes
  const changes: UpdateAgentInput = {
    systemPrompt: soul.systemPrompt,
  };

  // Create batch operation
  const operationId = await createBatchOperation({
    customerId,
    operationType: 'apply_soul',
    targetScope,
    presetType: 'soul',
    presetId,
    changes,
  });

  // Get target agents
  const agents = await getTargetAgents(customerId, targetScope, selectedAgentIds);

  await updateBatchOperation(operationId, {
    status: 'running',
    totalAgents: agents.length,
    affectedAgentIds: agents.map((a) => a.id),
    startedAt: new Date(),
  });

  // Process agents
  const errors: Array<{ agentId: string; error: string }> = [];
  let processed = 0;
  let failed = 0;

  for (const agent of agents) {
    try {
      await updateAgent(agent.id, customerId, changes);

      if (restartRunning && agent.status === 'running') {
        await publishAgentCommand(agent.id, 'restart');
      }

      processed++;
    } catch (error) {
      failed++;
      errors.push({
        agentId: agent.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  await updateBatchOperation(operationId, {
    status: failed > 0 && processed === 0 ? 'failed' : 'completed',
    processedAgents: processed,
    failedAgents: failed,
    errors,
    completedAt: new Date(),
  });

  // Update default soul for new agents
  if (targetScope === 'new_agents' || targetScope === 'all_agents') {
    await query(
      `INSERT INTO customer_config (customer_id, key, value)
       VALUES ($1, 'default_soul_id', $2)
       ON CONFLICT (customer_id, key) DO UPDATE SET value = $2`,
      [customerId, JSON.stringify(presetId)]
    );
  }

  return (await getBatchOperation(operationId))!;
}

// ============================================================================
// APPLY SKILLS
// ============================================================================

export async function applySkillsToAgents(options: {
  customerId: string;
  targetScope: BatchTargetScope;
  selectedAgentIds?: string[];
  skillPresetIds: string[];
  mode: 'add' | 'remove' | 'replace';
  restartRunning?: boolean;
}): Promise<BatchOperation> {
  const { customerId, targetScope, selectedAgentIds, skillPresetIds, mode, restartRunning } =
    options;

  const operationId = await createBatchOperation({
    customerId,
    operationType: `apply_skills_${mode}`,
    targetScope,
    presetType: 'skill',
    presetId: null,
    changes: { skillPresetIds, mode },
  });

  const agents = await getTargetAgents(customerId, targetScope, selectedAgentIds);

  await updateBatchOperation(operationId, {
    status: 'running',
    totalAgents: agents.length,
    affectedAgentIds: agents.map((a) => a.id),
    startedAt: new Date(),
  });

  const errors: Array<{ agentId: string; error: string }> = [];
  let processed = 0;
  let failed = 0;

  for (const agent of agents) {
    try {
      if (mode === 'replace') {
        await syncAgentSkills(agent.id, skillPresetIds);
      } else if (mode === 'add') {
        const { getAgentSkills, addAgentSkill } = await import(
          '../db/repositories/preset-repository.js'
        );
        const existing = await getAgentSkills(agent.id);
        const existingIds = new Set(existing.map((s) => s.skillPresetId));
        for (const skillId of skillPresetIds) {
          if (!existingIds.has(skillId)) {
            await addAgentSkill(agent.id, skillId);
          }
        }
      } else if (mode === 'remove') {
        const { removeAgentSkill } = await import('../db/repositories/preset-repository.js');
        for (const skillId of skillPresetIds) {
          await removeAgentSkill(agent.id, skillId);
        }
      }

      if (restartRunning && agent.status === 'running') {
        await publishAgentCommand(agent.id, 'restart');
      }

      processed++;
    } catch (error) {
      failed++;
      errors.push({
        agentId: agent.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  await updateBatchOperation(operationId, {
    status: failed > 0 && processed === 0 ? 'failed' : 'completed',
    processedAgents: processed,
    failedAgents: failed,
    errors,
    completedAt: new Date(),
  });

  // Update default skills for new agents
  if (targetScope === 'new_agents' || targetScope === 'all_agents') {
    if (mode === 'replace') {
      await query(
        `INSERT INTO customer_config (customer_id, key, value)
         VALUES ($1, 'default_skill_ids', $2)
         ON CONFLICT (customer_id, key) DO UPDATE SET value = $2`,
        [customerId, JSON.stringify(skillPresetIds)]
      );
    }
  }

  return (await getBatchOperation(operationId))!;
}

// ============================================================================
// BATCH CONFIG UPDATE
// ============================================================================

export async function batchUpdateAgents(options: BatchUpdateOptions): Promise<BatchOperation> {
  const { customerId, targetScope, selectedAgentIds, changes, restartRunning } = options;

  const operationId = await createBatchOperation({
    customerId,
    operationType: 'batch_update',
    targetScope,
    changes,
  });

  const agents = await getTargetAgents(customerId, targetScope, selectedAgentIds);

  await updateBatchOperation(operationId, {
    status: 'running',
    totalAgents: agents.length,
    affectedAgentIds: agents.map((a) => a.id),
    startedAt: new Date(),
  });

  const errors: Array<{ agentId: string; error: string }> = [];
  let processed = 0;
  let failed = 0;

  for (const agent of agents) {
    try {
      await updateAgent(agent.id, customerId, changes);

      if (restartRunning && agent.status === 'running') {
        await publishAgentCommand(agent.id, 'restart');
      }

      processed++;
    } catch (error) {
      failed++;
      errors.push({
        agentId: agent.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  await updateBatchOperation(operationId, {
    status: failed > 0 && processed === 0 ? 'failed' : 'completed',
    processedAgents: processed,
    failedAgents: failed,
    errors,
    completedAt: new Date(),
  });

  return (await getBatchOperation(operationId))!;
}

// ============================================================================
// GET CUSTOMER DEFAULTS
// ============================================================================

export async function getCustomerDefaults(customerId: string): Promise<{
  templateId: string | null;
  soulId: string | null;
  skillIds: string[];
}> {
  const results = await queryMany(
    `SELECT key, value FROM customer_config
     WHERE customer_id = $1 AND key IN ('default_template_id', 'default_soul_id', 'default_skill_ids')`,
    [customerId]
  );

  const config: Record<string, unknown> = {};
  for (const row of results) {
    config[row.key as string] = row.value;
  }

  return {
    templateId: (config.default_template_id as string) || null,
    soulId: (config.default_soul_id as string) || null,
    skillIds: (config.default_skill_ids as string[]) || [],
  };
}

export async function setCustomerDefaults(
  customerId: string,
  defaults: {
    templateId?: string | null;
    soulId?: string | null;
    skillIds?: string[];
  }
): Promise<void> {
  if (defaults.templateId !== undefined) {
    if (defaults.templateId) {
      await query(
        `INSERT INTO customer_config (customer_id, key, value)
         VALUES ($1, 'default_template_id', $2)
         ON CONFLICT (customer_id, key) DO UPDATE SET value = $2`,
        [customerId, JSON.stringify(defaults.templateId)]
      );
    } else {
      await query(
        `DELETE FROM customer_config WHERE customer_id = $1 AND key = 'default_template_id'`,
        [customerId]
      );
    }
  }

  if (defaults.soulId !== undefined) {
    if (defaults.soulId) {
      await query(
        `INSERT INTO customer_config (customer_id, key, value)
         VALUES ($1, 'default_soul_id', $2)
         ON CONFLICT (customer_id, key) DO UPDATE SET value = $2`,
        [customerId, JSON.stringify(defaults.soulId)]
      );
    } else {
      await query(
        `DELETE FROM customer_config WHERE customer_id = $1 AND key = 'default_soul_id'`,
        [customerId]
      );
    }
  }

  if (defaults.skillIds !== undefined) {
    await query(
      `INSERT INTO customer_config (customer_id, key, value)
       VALUES ($1, 'default_skill_ids', $2)
       ON CONFLICT (customer_id, key) DO UPDATE SET value = $2`,
      [customerId, JSON.stringify(defaults.skillIds)]
    );
  }
}
