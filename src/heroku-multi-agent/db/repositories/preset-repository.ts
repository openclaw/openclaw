/**
 * Preset Repository
 *
 * Data access layer for skills, souls, and agent templates.
 */

import { query, queryOne, queryMany } from '../client.js';

// ============================================================================
// TYPES
// ============================================================================

export interface SkillPreset {
  id: string;
  customerId: string | null;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  category: string;
  skillType: 'prompt' | 'tool' | 'integration';
  config: Record<string, unknown>;
  promptTemplate: string | null;
  toolDefinition: Record<string, unknown> | null;
  isActive: boolean;
  isDefault: boolean;
  isLocked: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SoulPreset {
  id: string;
  customerId: string | null;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  category: string;
  systemPrompt: string;
  personalityTraits: string[];
  tone: string;
  language: string;
  responseStyle: Record<string, unknown>;
  forbiddenTopics: string[];
  requiredDisclaimers: string[];
  isActive: boolean;
  isDefault: boolean;
  isLocked: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentTemplate {
  id: string;
  customerId: string | null;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  category: string;
  model: string;
  maxTokens: number;
  temperature: number;
  soulPresetId: string | null;
  customSystemPrompt: string | null;
  telegramGroupPolicy: string;
  telegramDmPolicy: string;
  skillPresetIds: string[];
  config: Record<string, unknown>;
  isActive: boolean;
  isDefault: boolean;
  isLocked: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSkill {
  id: string;
  agentId: string;
  skillPresetId: string;
  configOverride: Record<string, unknown>;
  isEnabled: boolean;
  createdAt: Date;
  skill?: SkillPreset;
}

// ============================================================================
// MAPPERS
// ============================================================================

function mapSkillPreset(row: Record<string, unknown>): SkillPreset {
  return {
    id: row.id as string,
    customerId: row.customer_id as string | null,
    name: row.name as string,
    slug: row.slug as string,
    description: row.description as string | null,
    icon: row.icon as string | null,
    category: row.category as string,
    skillType: row.skill_type as 'prompt' | 'tool' | 'integration',
    config: (row.config as Record<string, unknown>) || {},
    promptTemplate: row.prompt_template as string | null,
    toolDefinition: row.tool_definition as Record<string, unknown> | null,
    isActive: row.is_active as boolean,
    isDefault: row.is_default as boolean,
    isLocked: row.is_locked as boolean,
    sortOrder: row.sort_order as number,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSoulPreset(row: Record<string, unknown>): SoulPreset {
  return {
    id: row.id as string,
    customerId: row.customer_id as string | null,
    name: row.name as string,
    slug: row.slug as string,
    description: row.description as string | null,
    icon: row.icon as string | null,
    category: row.category as string,
    systemPrompt: row.system_prompt as string,
    personalityTraits: (row.personality_traits as string[]) || [],
    tone: row.tone as string,
    language: row.language as string,
    responseStyle: (row.response_style as Record<string, unknown>) || {},
    forbiddenTopics: (row.forbidden_topics as string[]) || [],
    requiredDisclaimers: (row.required_disclaimers as string[]) || [],
    isActive: row.is_active as boolean,
    isDefault: row.is_default as boolean,
    isLocked: row.is_locked as boolean,
    sortOrder: row.sort_order as number,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapAgentTemplate(row: Record<string, unknown>): AgentTemplate {
  return {
    id: row.id as string,
    customerId: row.customer_id as string | null,
    name: row.name as string,
    slug: row.slug as string,
    description: row.description as string | null,
    icon: row.icon as string | null,
    category: row.category as string,
    model: row.model as string,
    maxTokens: row.max_tokens as number,
    temperature: parseFloat(row.temperature as string),
    soulPresetId: row.soul_preset_id as string | null,
    customSystemPrompt: row.custom_system_prompt as string | null,
    telegramGroupPolicy: row.telegram_group_policy as string,
    telegramDmPolicy: row.telegram_dm_policy as string,
    skillPresetIds: (row.skill_preset_ids as string[]) || [],
    config: (row.config as Record<string, unknown>) || {},
    isActive: row.is_active as boolean,
    isDefault: row.is_default as boolean,
    isLocked: row.is_locked as boolean,
    sortOrder: row.sort_order as number,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// ============================================================================
// SKILL PRESETS
// ============================================================================

export async function listSkillPresets(customerId?: string | null): Promise<SkillPreset[]> {
  // Get global presets + customer-specific presets
  const result = await queryMany(
    `SELECT * FROM skill_presets
     WHERE is_active = TRUE AND (customer_id IS NULL OR customer_id = $1)
     ORDER BY sort_order, name`,
    [customerId]
  );
  return result.map(mapSkillPreset);
}

export async function getSkillPreset(id: string): Promise<SkillPreset | null> {
  const result = await queryOne(`SELECT * FROM skill_presets WHERE id = $1`, [id]);
  return result ? mapSkillPreset(result) : null;
}

export async function createSkillPreset(input: {
  customerId?: string | null;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  category?: string;
  skillType?: 'prompt' | 'tool' | 'integration';
  config?: Record<string, unknown>;
  promptTemplate?: string;
  isDefault?: boolean;
}): Promise<SkillPreset> {
  const result = await queryOne(
    `INSERT INTO skill_presets (
      customer_id, name, slug, description, icon, category, skill_type, config, prompt_template, is_default
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      input.customerId || null,
      input.name,
      input.slug,
      input.description || null,
      input.icon || null,
      input.category || 'general',
      input.skillType || 'prompt',
      JSON.stringify(input.config || {}),
      input.promptTemplate || null,
      input.isDefault || false,
    ]
  );
  return mapSkillPreset(result!);
}

export async function updateSkillPreset(
  id: string,
  input: Partial<{
    name: string;
    description: string;
    icon: string;
    category: string;
    config: Record<string, unknown>;
    promptTemplate: string;
    isActive: boolean;
    isDefault: boolean;
    sortOrder: number;
  }>
): Promise<SkillPreset | null> {
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    updates.push(`name = $${idx++}`);
    params.push(input.name);
  }
  if (input.description !== undefined) {
    updates.push(`description = $${idx++}`);
    params.push(input.description);
  }
  if (input.icon !== undefined) {
    updates.push(`icon = $${idx++}`);
    params.push(input.icon);
  }
  if (input.category !== undefined) {
    updates.push(`category = $${idx++}`);
    params.push(input.category);
  }
  if (input.config !== undefined) {
    updates.push(`config = $${idx++}`);
    params.push(JSON.stringify(input.config));
  }
  if (input.promptTemplate !== undefined) {
    updates.push(`prompt_template = $${idx++}`);
    params.push(input.promptTemplate);
  }
  if (input.isActive !== undefined) {
    updates.push(`is_active = $${idx++}`);
    params.push(input.isActive);
  }
  if (input.isDefault !== undefined) {
    updates.push(`is_default = $${idx++}`);
    params.push(input.isDefault);
  }
  if (input.sortOrder !== undefined) {
    updates.push(`sort_order = $${idx++}`);
    params.push(input.sortOrder);
  }

  if (updates.length === 0) return getSkillPreset(id);

  params.push(id);
  const result = await queryOne(
    `UPDATE skill_presets SET ${updates.join(', ')} WHERE id = $${idx} AND is_locked = FALSE RETURNING *`,
    params
  );
  return result ? mapSkillPreset(result) : null;
}

export async function deleteSkillPreset(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM skill_presets WHERE id = $1 AND is_locked = FALSE`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// SOUL PRESETS
// ============================================================================

export async function listSoulPresets(customerId?: string | null): Promise<SoulPreset[]> {
  const result = await queryMany(
    `SELECT * FROM soul_presets
     WHERE is_active = TRUE AND (customer_id IS NULL OR customer_id = $1)
     ORDER BY sort_order, name`,
    [customerId]
  );
  return result.map(mapSoulPreset);
}

export async function getSoulPreset(id: string): Promise<SoulPreset | null> {
  const result = await queryOne(`SELECT * FROM soul_presets WHERE id = $1`, [id]);
  return result ? mapSoulPreset(result) : null;
}

export async function createSoulPreset(input: {
  customerId?: string | null;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  category?: string;
  systemPrompt: string;
  personalityTraits?: string[];
  tone?: string;
  language?: string;
  responseStyle?: Record<string, unknown>;
  forbiddenTopics?: string[];
  requiredDisclaimers?: string[];
  isDefault?: boolean;
}): Promise<SoulPreset> {
  const result = await queryOne(
    `INSERT INTO soul_presets (
      customer_id, name, slug, description, icon, category, system_prompt,
      personality_traits, tone, language, response_style, forbidden_topics,
      required_disclaimers, is_default
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [
      input.customerId || null,
      input.name,
      input.slug,
      input.description || null,
      input.icon || null,
      input.category || 'general',
      input.systemPrompt,
      JSON.stringify(input.personalityTraits || []),
      input.tone || 'neutral',
      input.language || 'en',
      JSON.stringify(input.responseStyle || {}),
      JSON.stringify(input.forbiddenTopics || []),
      JSON.stringify(input.requiredDisclaimers || []),
      input.isDefault || false,
    ]
  );
  return mapSoulPreset(result!);
}

export async function updateSoulPreset(
  id: string,
  input: Partial<{
    name: string;
    description: string;
    icon: string;
    category: string;
    systemPrompt: string;
    personalityTraits: string[];
    tone: string;
    responseStyle: Record<string, unknown>;
    forbiddenTopics: string[];
    requiredDisclaimers: string[];
    isActive: boolean;
    isDefault: boolean;
    sortOrder: number;
  }>
): Promise<SoulPreset | null> {
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    updates.push(`name = $${idx++}`);
    params.push(input.name);
  }
  if (input.description !== undefined) {
    updates.push(`description = $${idx++}`);
    params.push(input.description);
  }
  if (input.icon !== undefined) {
    updates.push(`icon = $${idx++}`);
    params.push(input.icon);
  }
  if (input.category !== undefined) {
    updates.push(`category = $${idx++}`);
    params.push(input.category);
  }
  if (input.systemPrompt !== undefined) {
    updates.push(`system_prompt = $${idx++}`);
    params.push(input.systemPrompt);
  }
  if (input.personalityTraits !== undefined) {
    updates.push(`personality_traits = $${idx++}`);
    params.push(JSON.stringify(input.personalityTraits));
  }
  if (input.tone !== undefined) {
    updates.push(`tone = $${idx++}`);
    params.push(input.tone);
  }
  if (input.responseStyle !== undefined) {
    updates.push(`response_style = $${idx++}`);
    params.push(JSON.stringify(input.responseStyle));
  }
  if (input.forbiddenTopics !== undefined) {
    updates.push(`forbidden_topics = $${idx++}`);
    params.push(JSON.stringify(input.forbiddenTopics));
  }
  if (input.requiredDisclaimers !== undefined) {
    updates.push(`required_disclaimers = $${idx++}`);
    params.push(JSON.stringify(input.requiredDisclaimers));
  }
  if (input.isActive !== undefined) {
    updates.push(`is_active = $${idx++}`);
    params.push(input.isActive);
  }
  if (input.isDefault !== undefined) {
    updates.push(`is_default = $${idx++}`);
    params.push(input.isDefault);
  }
  if (input.sortOrder !== undefined) {
    updates.push(`sort_order = $${idx++}`);
    params.push(input.sortOrder);
  }

  if (updates.length === 0) return getSoulPreset(id);

  params.push(id);
  const result = await queryOne(
    `UPDATE soul_presets SET ${updates.join(', ')} WHERE id = $${idx} AND is_locked = FALSE RETURNING *`,
    params
  );
  return result ? mapSoulPreset(result) : null;
}

export async function deleteSoulPreset(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM soul_presets WHERE id = $1 AND is_locked = FALSE`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// AGENT TEMPLATES
// ============================================================================

export async function listAgentTemplates(customerId?: string | null): Promise<AgentTemplate[]> {
  const result = await queryMany(
    `SELECT * FROM agent_templates
     WHERE is_active = TRUE AND (customer_id IS NULL OR customer_id = $1)
     ORDER BY sort_order, name`,
    [customerId]
  );
  return result.map(mapAgentTemplate);
}

export async function getAgentTemplate(id: string): Promise<AgentTemplate | null> {
  const result = await queryOne(`SELECT * FROM agent_templates WHERE id = $1`, [id]);
  return result ? mapAgentTemplate(result) : null;
}

export async function createAgentTemplate(input: {
  customerId?: string | null;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  category?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  soulPresetId?: string;
  customSystemPrompt?: string;
  telegramGroupPolicy?: string;
  telegramDmPolicy?: string;
  skillPresetIds?: string[];
  config?: Record<string, unknown>;
  isDefault?: boolean;
}): Promise<AgentTemplate> {
  const result = await queryOne(
    `INSERT INTO agent_templates (
      customer_id, name, slug, description, icon, category, model, max_tokens, temperature,
      soul_preset_id, custom_system_prompt, telegram_group_policy, telegram_dm_policy,
      skill_preset_ids, config, is_default
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING *`,
    [
      input.customerId || null,
      input.name,
      input.slug,
      input.description || null,
      input.icon || null,
      input.category || 'general',
      input.model || 'claude-sonnet-4-20250514',
      input.maxTokens || 4096,
      input.temperature || 0.7,
      input.soulPresetId || null,
      input.customSystemPrompt || null,
      input.telegramGroupPolicy || 'disabled',
      input.telegramDmPolicy || 'allowlist',
      input.skillPresetIds || [],
      JSON.stringify(input.config || {}),
      input.isDefault || false,
    ]
  );
  return mapAgentTemplate(result!);
}

export async function updateAgentTemplate(
  id: string,
  input: Partial<{
    name: string;
    description: string;
    icon: string;
    category: string;
    model: string;
    maxTokens: number;
    temperature: number;
    soulPresetId: string | null;
    customSystemPrompt: string | null;
    telegramGroupPolicy: string;
    telegramDmPolicy: string;
    skillPresetIds: string[];
    config: Record<string, unknown>;
    isActive: boolean;
    isDefault: boolean;
    sortOrder: number;
  }>
): Promise<AgentTemplate | null> {
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const fieldMap: Record<string, string> = {
    name: 'name',
    description: 'description',
    icon: 'icon',
    category: 'category',
    model: 'model',
    maxTokens: 'max_tokens',
    temperature: 'temperature',
    soulPresetId: 'soul_preset_id',
    customSystemPrompt: 'custom_system_prompt',
    telegramGroupPolicy: 'telegram_group_policy',
    telegramDmPolicy: 'telegram_dm_policy',
    isActive: 'is_active',
    isDefault: 'is_default',
    sortOrder: 'sort_order',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if ((input as Record<string, unknown>)[key] !== undefined) {
      updates.push(`${col} = $${idx++}`);
      params.push((input as Record<string, unknown>)[key]);
    }
  }

  if (input.skillPresetIds !== undefined) {
    updates.push(`skill_preset_ids = $${idx++}`);
    params.push(input.skillPresetIds);
  }
  if (input.config !== undefined) {
    updates.push(`config = $${idx++}`);
    params.push(JSON.stringify(input.config));
  }

  if (updates.length === 0) return getAgentTemplate(id);

  params.push(id);
  const result = await queryOne(
    `UPDATE agent_templates SET ${updates.join(', ')} WHERE id = $${idx} AND is_locked = FALSE RETURNING *`,
    params
  );
  return result ? mapAgentTemplate(result) : null;
}

export async function deleteAgentTemplate(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM agent_templates WHERE id = $1 AND is_locked = FALSE`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// AGENT SKILLS
// ============================================================================

export async function getAgentSkills(agentId: string): Promise<AgentSkill[]> {
  const result = await queryMany(
    `SELECT as.*, sp.name as skill_name, sp.slug as skill_slug, sp.icon as skill_icon,
            sp.category as skill_category, sp.skill_type, sp.prompt_template
     FROM agent_skills as
     JOIN skill_presets sp ON as.skill_preset_id = sp.id
     WHERE as.agent_id = $1
     ORDER BY sp.sort_order, sp.name`,
    [agentId]
  );
  return result.map((row) => ({
    id: row.id as string,
    agentId: row.agent_id as string,
    skillPresetId: row.skill_preset_id as string,
    configOverride: (row.config_override as Record<string, unknown>) || {},
    isEnabled: row.is_enabled as boolean,
    createdAt: new Date(row.created_at as string),
    skill: {
      id: row.skill_preset_id as string,
      customerId: null,
      name: row.skill_name as string,
      slug: row.skill_slug as string,
      description: null,
      icon: row.skill_icon as string | null,
      category: row.skill_category as string,
      skillType: row.skill_type as 'prompt' | 'tool' | 'integration',
      config: {},
      promptTemplate: row.prompt_template as string | null,
      toolDefinition: null,
      isActive: true,
      isDefault: false,
      isLocked: false,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  }));
}

export async function addAgentSkill(
  agentId: string,
  skillPresetId: string,
  configOverride?: Record<string, unknown>
): Promise<AgentSkill> {
  const result = await queryOne(
    `INSERT INTO agent_skills (agent_id, skill_preset_id, config_override)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, skill_preset_id) DO UPDATE SET config_override = $3, is_enabled = TRUE
     RETURNING *`,
    [agentId, skillPresetId, JSON.stringify(configOverride || {})]
  );
  return {
    id: result!.id as string,
    agentId: result!.agent_id as string,
    skillPresetId: result!.skill_preset_id as string,
    configOverride: (result!.config_override as Record<string, unknown>) || {},
    isEnabled: result!.is_enabled as boolean,
    createdAt: new Date(result!.created_at as string),
  };
}

export async function updateAgentSkill(
  agentId: string,
  skillPresetId: string,
  input: { configOverride?: Record<string, unknown>; isEnabled?: boolean }
): Promise<boolean> {
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.configOverride !== undefined) {
    updates.push(`config_override = $${idx++}`);
    params.push(JSON.stringify(input.configOverride));
  }
  if (input.isEnabled !== undefined) {
    updates.push(`is_enabled = $${idx++}`);
    params.push(input.isEnabled);
  }

  if (updates.length === 0) return true;

  params.push(agentId, skillPresetId);
  const result = await query(
    `UPDATE agent_skills SET ${updates.join(', ')} WHERE agent_id = $${idx++} AND skill_preset_id = $${idx}`,
    params
  );
  return (result.rowCount ?? 0) > 0;
}

export async function removeAgentSkill(agentId: string, skillPresetId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM agent_skills WHERE agent_id = $1 AND skill_preset_id = $2`,
    [agentId, skillPresetId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function syncAgentSkills(agentId: string, skillPresetIds: string[]): Promise<void> {
  // Remove skills not in the new list
  await query(
    `DELETE FROM agent_skills WHERE agent_id = $1 AND skill_preset_id != ALL($2)`,
    [agentId, skillPresetIds]
  );

  // Add new skills
  for (const skillId of skillPresetIds) {
    await addAgentSkill(agentId, skillId);
  }
}

// ============================================================================
// DEFAULT PRESETS
// ============================================================================

export async function getDefaultSkillPresets(): Promise<SkillPreset[]> {
  const result = await queryMany(
    `SELECT * FROM skill_presets WHERE is_default = TRUE AND is_active = TRUE ORDER BY sort_order`
  );
  return result.map(mapSkillPreset);
}

export async function getDefaultSoulPreset(): Promise<SoulPreset | null> {
  const result = await queryOne(
    `SELECT * FROM soul_presets WHERE is_default = TRUE AND is_active = TRUE LIMIT 1`
  );
  return result ? mapSoulPreset(result) : null;
}

export async function getDefaultAgentTemplate(): Promise<AgentTemplate | null> {
  const result = await queryOne(
    `SELECT * FROM agent_templates WHERE is_default = TRUE AND is_active = TRUE LIMIT 1`
  );
  return result ? mapAgentTemplate(result) : null;
}
