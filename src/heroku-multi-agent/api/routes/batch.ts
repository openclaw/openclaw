/**
 * Batch Operations Routes
 *
 * API endpoints for bulk operations on agents.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  applyTemplateToAgents,
  applySoulToAgents,
  applySkillsToAgents,
  batchUpdateAgents,
  getBatchOperation,
  listBatchOperations,
  type BatchTargetScope,
} from '../../services/batch-operations.js';
import { setAuditAction } from '../middleware/audit.js';

const router = Router();

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const targetScopeSchema = z.enum(['new_agents', 'existing_agents', 'all_agents', 'selected_agents']);

const applyPresetSchema = z.object({
  presetType: z.enum(['template', 'soul', 'skill']),
  presetId: z.string().uuid(),
  targetScope: targetScopeSchema,
  selectedAgentIds: z.array(z.string().uuid()).optional(),
  applySkills: z.boolean().optional(),
  restartRunning: z.boolean().optional(),
});

const applySkillsSchema = z.object({
  skillPresetIds: z.array(z.string().uuid()).min(1).max(20),
  targetScope: targetScopeSchema,
  selectedAgentIds: z.array(z.string().uuid()).optional(),
  mode: z.enum(['add', 'remove', 'replace']),
  restartRunning: z.boolean().optional(),
});

const batchUpdateSchema = z.object({
  targetScope: targetScopeSchema,
  selectedAgentIds: z.array(z.string().uuid()).optional(),
  changes: z.object({
    name: z.string().min(1).max(255).optional(),
    systemPrompt: z.string().max(50000).optional(),
    model: z.string().max(100).optional(),
    maxTokens: z.number().int().min(256).max(8192).optional(),
    temperature: z.number().min(0).max(1).optional(),
    telegramAllowFrom: z.array(z.string()).optional(),
    telegramGroupPolicy: z.enum(['open', 'disabled', 'allowlist']).optional(),
    telegramDmPolicy: z.enum(['pairing', 'allowlist', 'open', 'disabled']).optional(),
  }),
  restartRunning: z.boolean().optional(),
});

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Apply a preset to agents
 * POST /api/v1/batch/apply
 */
router.post('/apply', async (req, res) => {
  try {
    const input = applyPresetSchema.parse(req.body);
    const customerId = req.customer!.id;

    setAuditAction(req, 'agent.update', 'batch', undefined, {
      operation: `apply_${input.presetType}`,
      presetId: input.presetId,
      targetScope: input.targetScope,
    });

    let operation;

    switch (input.presetType) {
      case 'template':
        operation = await applyTemplateToAgents({
          customerId,
          targetScope: input.targetScope as BatchTargetScope,
          selectedAgentIds: input.selectedAgentIds,
          presetType: 'template',
          presetId: input.presetId,
          applySkills: input.applySkills,
          restartRunning: input.restartRunning,
        });
        break;

      case 'soul':
        operation = await applySoulToAgents({
          customerId,
          targetScope: input.targetScope as BatchTargetScope,
          selectedAgentIds: input.selectedAgentIds,
          presetType: 'soul',
          presetId: input.presetId,
          restartRunning: input.restartRunning,
        });
        break;

      case 'skill':
        // For single skill apply, use 'add' mode
        operation = await applySkillsToAgents({
          customerId,
          targetScope: input.targetScope as BatchTargetScope,
          selectedAgentIds: input.selectedAgentIds,
          skillPresetIds: [input.presetId],
          mode: 'add',
          restartRunning: input.restartRunning,
        });
        break;
    }

    res.json({
      message: 'Preset applied',
      operation,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Batch] Apply preset error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Apply skills to agents
 * POST /api/v1/batch/skills
 */
router.post('/skills', async (req, res) => {
  try {
    const input = applySkillsSchema.parse(req.body);
    const customerId = req.customer!.id;

    setAuditAction(req, 'agent.update', 'batch', undefined, {
      operation: `skills_${input.mode}`,
      skillCount: input.skillPresetIds.length,
      targetScope: input.targetScope,
    });

    const operation = await applySkillsToAgents({
      customerId,
      targetScope: input.targetScope as BatchTargetScope,
      selectedAgentIds: input.selectedAgentIds,
      skillPresetIds: input.skillPresetIds,
      mode: input.mode,
      restartRunning: input.restartRunning,
    });

    res.json({
      message: 'Skills updated',
      operation,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Batch] Apply skills error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Batch update agent configuration
 * POST /api/v1/batch/update
 */
router.post('/update', async (req, res) => {
  try {
    const input = batchUpdateSchema.parse(req.body);
    const customerId = req.customer!.id;

    setAuditAction(req, 'agent.update', 'batch', undefined, {
      operation: 'batch_update',
      targetScope: input.targetScope,
      changedFields: Object.keys(input.changes),
    });

    const operation = await batchUpdateAgents({
      customerId,
      targetScope: input.targetScope as BatchTargetScope,
      selectedAgentIds: input.selectedAgentIds,
      changes: input.changes,
      restartRunning: input.restartRunning,
    });

    res.json({
      message: 'Agents updated',
      operation,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Batch] Update error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get batch operation status
 * GET /api/v1/batch/operations/:id
 */
router.get('/operations/:id', async (req, res) => {
  try {
    const operation = await getBatchOperation(req.params.id);

    if (!operation || operation.customerId !== req.customer!.id) {
      res.status(404).json({ error: 'Not Found', message: 'Operation not found' });
      return;
    }

    res.json({ operation });
  } catch (error) {
    console.error('[Batch] Get operation error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * List batch operations
 * GET /api/v1/batch/operations
 */
router.get('/operations', async (req, res) => {
  try {
    const { limit, offset } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const result = await listBatchOperations(req.customer!.id, { limit, offset });

    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Batch] List operations error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
