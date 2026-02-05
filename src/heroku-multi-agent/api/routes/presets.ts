/**
 * Presets Routes
 *
 * API endpoints for managing skills, souls, and agent templates.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  listSkillPresets,
  getSkillPreset,
  createSkillPreset,
  updateSkillPreset,
  deleteSkillPreset,
  listSoulPresets,
  getSoulPreset,
  createSoulPreset,
  updateSoulPreset,
  deleteSoulPreset,
  listAgentTemplates,
  getAgentTemplate,
  createAgentTemplate,
  updateAgentTemplate,
  deleteAgentTemplate,
  getAgentSkills,
  addAgentSkill,
  updateAgentSkill,
  removeAgentSkill,
  syncAgentSkills,
} from '../../db/repositories/preset-repository.js';
import { findAgentByIdForCustomer } from '../../db/repositories/agent-repository.js';
import { setAuditAction } from '../middleware/audit.js';

const router = Router();

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const createSkillSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  skillType: z.enum(['prompt', 'tool', 'integration']).optional(),
  config: z.record(z.unknown()).optional(),
  promptTemplate: z.string().max(10000).optional(),
  isDefault: z.boolean().optional(),
});

const updateSkillSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  config: z.record(z.unknown()).optional(),
  promptTemplate: z.string().max(10000).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const createSoulSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  systemPrompt: z.string().min(1).max(50000),
  personalityTraits: z.array(z.string()).max(20).optional(),
  tone: z.string().max(100).optional(),
  language: z.string().max(10).optional(),
  responseStyle: z.record(z.unknown()).optional(),
  forbiddenTopics: z.array(z.string()).max(50).optional(),
  requiredDisclaimers: z.array(z.string()).max(10).optional(),
  isDefault: z.boolean().optional(),
});

const updateSoulSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  systemPrompt: z.string().min(1).max(50000).optional(),
  personalityTraits: z.array(z.string()).max(20).optional(),
  tone: z.string().max(100).optional(),
  responseStyle: z.record(z.unknown()).optional(),
  forbiddenTopics: z.array(z.string()).max(50).optional(),
  requiredDisclaimers: z.array(z.string()).max(10).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  maxTokens: z.number().int().min(256).max(8192).optional(),
  temperature: z.number().min(0).max(1).optional(),
  soulPresetId: z.string().uuid().optional(),
  customSystemPrompt: z.string().max(50000).optional(),
  telegramGroupPolicy: z.enum(['open', 'disabled', 'allowlist']).optional(),
  telegramDmPolicy: z.enum(['pairing', 'allowlist', 'open', 'disabled']).optional(),
  skillPresetIds: z.array(z.string().uuid()).max(20).optional(),
  config: z.record(z.unknown()).optional(),
  isDefault: z.boolean().optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  maxTokens: z.number().int().min(256).max(8192).optional(),
  temperature: z.number().min(0).max(1).optional(),
  soulPresetId: z.string().uuid().nullable().optional(),
  customSystemPrompt: z.string().max(50000).nullable().optional(),
  telegramGroupPolicy: z.enum(['open', 'disabled', 'allowlist']).optional(),
  telegramDmPolicy: z.enum(['pairing', 'allowlist', 'open', 'disabled']).optional(),
  skillPresetIds: z.array(z.string().uuid()).max(20).optional(),
  config: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

// ============================================================================
// SKILL PRESETS
// ============================================================================

/**
 * List all skill presets
 * GET /api/v1/presets/skills
 */
router.get('/skills', async (req, res) => {
  try {
    const skills = await listSkillPresets(req.customer?.id);

    res.json({
      skills,
      total: skills.length,
    });
  } catch (error) {
    console.error('[Presets] List skills error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get a skill preset
 * GET /api/v1/presets/skills/:id
 */
router.get('/skills/:id', async (req, res) => {
  try {
    const skill = await getSkillPreset(req.params.id);
    if (!skill) {
      res.status(404).json({ error: 'Not Found', message: 'Skill preset not found' });
      return;
    }

    res.json({ skill });
  } catch (error) {
    console.error('[Presets] Get skill error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Create a skill preset
 * POST /api/v1/presets/skills
 */
router.post('/skills', async (req, res) => {
  try {
    const input = createSkillSchema.parse(req.body);

    setAuditAction(req, 'credentials.set', 'skill_preset', undefined, { action: 'create' });

    const skill = await createSkillPreset({
      ...input,
      customerId: req.customer?.id,
    });

    res.status(201).json({ skill });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Create skill error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Update a skill preset
 * PATCH /api/v1/presets/skills/:id
 */
router.patch('/skills/:id', async (req, res) => {
  try {
    const input = updateSkillSchema.parse(req.body);

    setAuditAction(req, 'credentials.set', 'skill_preset', req.params.id, { action: 'update' });

    const skill = await updateSkillPreset(req.params.id, input);
    if (!skill) {
      res.status(404).json({ error: 'Not Found', message: 'Skill preset not found or locked' });
      return;
    }

    res.json({ skill });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Update skill error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Delete a skill preset
 * DELETE /api/v1/presets/skills/:id
 */
router.delete('/skills/:id', async (req, res) => {
  try {
    setAuditAction(req, 'credentials.delete', 'skill_preset', req.params.id);

    const deleted = await deleteSkillPreset(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Not Found', message: 'Skill preset not found or locked' });
      return;
    }

    res.json({ message: 'Skill preset deleted' });
  } catch (error) {
    console.error('[Presets] Delete skill error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================================
// SOUL PRESETS
// ============================================================================

/**
 * List all soul presets
 * GET /api/v1/presets/souls
 */
router.get('/souls', async (req, res) => {
  try {
    const souls = await listSoulPresets(req.customer?.id);

    res.json({
      souls,
      total: souls.length,
    });
  } catch (error) {
    console.error('[Presets] List souls error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get a soul preset
 * GET /api/v1/presets/souls/:id
 */
router.get('/souls/:id', async (req, res) => {
  try {
    const soul = await getSoulPreset(req.params.id);
    if (!soul) {
      res.status(404).json({ error: 'Not Found', message: 'Soul preset not found' });
      return;
    }

    res.json({ soul });
  } catch (error) {
    console.error('[Presets] Get soul error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Create a soul preset
 * POST /api/v1/presets/souls
 */
router.post('/souls', async (req, res) => {
  try {
    const input = createSoulSchema.parse(req.body);

    setAuditAction(req, 'credentials.set', 'soul_preset', undefined, { action: 'create' });

    const soul = await createSoulPreset({
      ...input,
      customerId: req.customer?.id,
    });

    res.status(201).json({ soul });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Create soul error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Update a soul preset
 * PATCH /api/v1/presets/souls/:id
 */
router.patch('/souls/:id', async (req, res) => {
  try {
    const input = updateSoulSchema.parse(req.body);

    setAuditAction(req, 'credentials.set', 'soul_preset', req.params.id, { action: 'update' });

    const soul = await updateSoulPreset(req.params.id, input);
    if (!soul) {
      res.status(404).json({ error: 'Not Found', message: 'Soul preset not found or locked' });
      return;
    }

    res.json({ soul });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Update soul error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Delete a soul preset
 * DELETE /api/v1/presets/souls/:id
 */
router.delete('/souls/:id', async (req, res) => {
  try {
    setAuditAction(req, 'credentials.delete', 'soul_preset', req.params.id);

    const deleted = await deleteSoulPreset(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Not Found', message: 'Soul preset not found or locked' });
      return;
    }

    res.json({ message: 'Soul preset deleted' });
  } catch (error) {
    console.error('[Presets] Delete soul error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================================
// AGENT TEMPLATES
// ============================================================================

/**
 * List all agent templates
 * GET /api/v1/presets/templates
 */
router.get('/templates', async (req, res) => {
  try {
    const templates = await listAgentTemplates(req.customer?.id);

    res.json({
      templates,
      total: templates.length,
    });
  } catch (error) {
    console.error('[Presets] List templates error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Get an agent template
 * GET /api/v1/presets/templates/:id
 */
router.get('/templates/:id', async (req, res) => {
  try {
    const template = await getAgentTemplate(req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Not Found', message: 'Agent template not found' });
      return;
    }

    // Fetch associated soul and skills
    const [soul, skills] = await Promise.all([
      template.soulPresetId ? getSoulPreset(template.soulPresetId) : null,
      Promise.all(template.skillPresetIds.map((id) => getSkillPreset(id))),
    ]);

    res.json({
      template,
      soul,
      skills: skills.filter(Boolean),
    });
  } catch (error) {
    console.error('[Presets] Get template error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Create an agent template
 * POST /api/v1/presets/templates
 */
router.post('/templates', async (req, res) => {
  try {
    const input = createTemplateSchema.parse(req.body);

    setAuditAction(req, 'credentials.set', 'agent_template', undefined, { action: 'create' });

    const template = await createAgentTemplate({
      ...input,
      customerId: req.customer?.id,
    });

    res.status(201).json({ template });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Create template error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Update an agent template
 * PATCH /api/v1/presets/templates/:id
 */
router.patch('/templates/:id', async (req, res) => {
  try {
    const input = updateTemplateSchema.parse(req.body);

    setAuditAction(req, 'credentials.set', 'agent_template', req.params.id, { action: 'update' });

    const template = await updateAgentTemplate(req.params.id, input);
    if (!template) {
      res.status(404).json({ error: 'Not Found', message: 'Agent template not found or locked' });
      return;
    }

    res.json({ template });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Update template error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Delete an agent template
 * DELETE /api/v1/presets/templates/:id
 */
router.delete('/templates/:id', async (req, res) => {
  try {
    setAuditAction(req, 'credentials.delete', 'agent_template', req.params.id);

    const deleted = await deleteAgentTemplate(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Not Found', message: 'Agent template not found or locked' });
      return;
    }

    res.json({ message: 'Agent template deleted' });
  } catch (error) {
    console.error('[Presets] Delete template error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ============================================================================
// AGENT SKILLS
// ============================================================================

/**
 * Get skills for an agent
 * GET /api/v1/agents/:id/skills
 */
router.get('/agents/:id/skills', async (req, res) => {
  try {
    const agent = await findAgentByIdForCustomer(req.params.id, req.customer!.id);
    if (!agent) {
      res.status(404).json({ error: 'Not Found', message: 'Agent not found' });
      return;
    }

    const skills = await getAgentSkills(agent.id);

    res.json({
      skills,
      total: skills.length,
    });
  } catch (error) {
    console.error('[Presets] Get agent skills error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Add a skill to an agent
 * POST /api/v1/agents/:id/skills
 */
router.post('/agents/:id/skills', async (req, res) => {
  try {
    const { skillPresetId, configOverride } = z
      .object({
        skillPresetId: z.string().uuid(),
        configOverride: z.record(z.unknown()).optional(),
      })
      .parse(req.body);

    const agent = await findAgentByIdForCustomer(req.params.id, req.customer!.id);
    if (!agent) {
      res.status(404).json({ error: 'Not Found', message: 'Agent not found' });
      return;
    }

    setAuditAction(req, 'credentials.set', 'agent_skill', req.params.id);

    const agentSkill = await addAgentSkill(agent.id, skillPresetId, configOverride);

    res.status(201).json({ agentSkill });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Add agent skill error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Update an agent skill
 * PATCH /api/v1/agents/:id/skills/:skillId
 */
router.patch('/agents/:id/skills/:skillId', async (req, res) => {
  try {
    const input = z
      .object({
        configOverride: z.record(z.unknown()).optional(),
        isEnabled: z.boolean().optional(),
      })
      .parse(req.body);

    const agent = await findAgentByIdForCustomer(req.params.id, req.customer!.id);
    if (!agent) {
      res.status(404).json({ error: 'Not Found', message: 'Agent not found' });
      return;
    }

    setAuditAction(req, 'credentials.set', 'agent_skill', req.params.id);

    await updateAgentSkill(agent.id, req.params.skillId, input);

    res.json({ message: 'Agent skill updated' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Update agent skill error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Remove a skill from an agent
 * DELETE /api/v1/agents/:id/skills/:skillId
 */
router.delete('/agents/:id/skills/:skillId', async (req, res) => {
  try {
    const agent = await findAgentByIdForCustomer(req.params.id, req.customer!.id);
    if (!agent) {
      res.status(404).json({ error: 'Not Found', message: 'Agent not found' });
      return;
    }

    setAuditAction(req, 'credentials.delete', 'agent_skill', req.params.id);

    await removeAgentSkill(agent.id, req.params.skillId);

    res.json({ message: 'Agent skill removed' });
  } catch (error) {
    console.error('[Presets] Remove agent skill error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Sync agent skills (replace all)
 * PUT /api/v1/agents/:id/skills
 */
router.put('/agents/:id/skills', async (req, res) => {
  try {
    const { skillPresetIds } = z
      .object({
        skillPresetIds: z.array(z.string().uuid()).max(20),
      })
      .parse(req.body);

    const agent = await findAgentByIdForCustomer(req.params.id, req.customer!.id);
    if (!agent) {
      res.status(404).json({ error: 'Not Found', message: 'Agent not found' });
      return;
    }

    setAuditAction(req, 'credentials.set', 'agent_skill', req.params.id, { action: 'sync' });

    await syncAgentSkills(agent.id, skillPresetIds);

    const skills = await getAgentSkills(agent.id);

    res.json({
      message: 'Agent skills synced',
      skills,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation Error', details: error.errors });
      return;
    }
    console.error('[Presets] Sync agent skills error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
