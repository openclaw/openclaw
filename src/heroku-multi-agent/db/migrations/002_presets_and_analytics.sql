-- Migration: 002_presets_and_analytics.sql
-- Adds preset management, templates, and analytics tables

-- =============================================================================
-- PRESETS: Reusable configurations for agents
-- =============================================================================

-- Skill presets (tools/capabilities that can be enabled/disabled)
CREATE TABLE skill_presets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,  -- NULL = global/platform preset

    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(100),  -- emoji or icon name
    category VARCHAR(100) DEFAULT 'general',

    -- Skill configuration (what this skill enables)
    skill_type VARCHAR(50) NOT NULL DEFAULT 'prompt',  -- 'prompt', 'tool', 'integration'
    config JSONB NOT NULL DEFAULT '{}',

    -- For prompt-based skills
    prompt_template TEXT,

    -- For tool-based skills (restricted - admin only)
    tool_definition JSONB,  -- Tool schema if skill_type = 'tool'

    -- Visibility
    is_active BOOLEAN DEFAULT TRUE,
    is_default BOOLEAN DEFAULT FALSE,  -- Include in new agents by default
    is_locked BOOLEAN DEFAULT FALSE,   -- Cannot be modified by customers

    -- Ordering
    sort_order INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, slug)
);

-- Soul presets (personality/behavior templates)
CREATE TABLE soul_presets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,  -- NULL = global

    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(100),
    category VARCHAR(100) DEFAULT 'general',

    -- Soul definition
    system_prompt TEXT NOT NULL,
    personality_traits JSONB DEFAULT '[]',  -- ["friendly", "professional", "concise"]
    tone VARCHAR(100) DEFAULT 'neutral',     -- "formal", "casual", "friendly", etc.
    language VARCHAR(10) DEFAULT 'en',

    -- Behavioral constraints
    response_style JSONB DEFAULT '{}',  -- max_length, formatting preferences
    forbidden_topics JSONB DEFAULT '[]',
    required_disclaimers JSONB DEFAULT '[]',

    -- Visibility
    is_active BOOLEAN DEFAULT TRUE,
    is_default BOOLEAN DEFAULT FALSE,
    is_locked BOOLEAN DEFAULT FALSE,

    sort_order INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, slug)
);

-- Agent templates (complete agent configurations)
CREATE TABLE agent_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    description TEXT,
    icon VARCHAR(100),
    category VARCHAR(100) DEFAULT 'general',

    -- Base configuration
    model VARCHAR(100) DEFAULT 'claude-sonnet-4-20250514',
    max_tokens INTEGER DEFAULT 4096,
    temperature DECIMAL(3,2) DEFAULT 0.7,

    -- Soul reference or inline
    soul_preset_id UUID REFERENCES soul_presets(id) ON DELETE SET NULL,
    custom_system_prompt TEXT,  -- Override if no soul_preset_id

    -- Telegram defaults
    telegram_group_policy VARCHAR(50) DEFAULT 'disabled',
    telegram_dm_policy VARCHAR(50) DEFAULT 'allowlist',

    -- Skills to include
    skill_preset_ids UUID[] DEFAULT '{}',

    -- Additional config
    config JSONB DEFAULT '{}',

    -- Visibility
    is_active BOOLEAN DEFAULT TRUE,
    is_default BOOLEAN DEFAULT FALSE,
    is_locked BOOLEAN DEFAULT FALSE,

    sort_order INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, slug)
);

-- Junction table: Agent <-> Skills
CREATE TABLE agent_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_preset_id UUID NOT NULL REFERENCES skill_presets(id) ON DELETE CASCADE,

    -- Override configuration for this agent
    config_override JSONB DEFAULT '{}',
    is_enabled BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(agent_id, skill_preset_id)
);

-- =============================================================================
-- CONFIGURATION: Platform and customer settings
-- =============================================================================

CREATE TABLE platform_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(255) UNIQUE NOT NULL,
    value JSONB NOT NULL,
    description TEXT,
    is_secret BOOLEAN DEFAULT FALSE,
    updated_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE customer_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, key)
);

-- =============================================================================
-- ANALYTICS: Usage statistics and metrics
-- =============================================================================

-- Hourly aggregated stats per agent
CREATE TABLE agent_stats_hourly (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    hour_bucket TIMESTAMPTZ NOT NULL,  -- Truncated to hour

    -- Message metrics
    message_count INTEGER DEFAULT 0,
    input_tokens BIGINT DEFAULT 0,
    output_tokens BIGINT DEFAULT 0,

    -- Response metrics
    avg_response_time_ms INTEGER,
    min_response_time_ms INTEGER,
    max_response_time_ms INTEGER,

    -- Error metrics
    error_count INTEGER DEFAULT 0,
    timeout_count INTEGER DEFAULT 0,

    -- User metrics
    unique_users INTEGER DEFAULT 0,
    new_users INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(agent_id, hour_bucket)
);

-- Daily aggregated stats per customer
CREATE TABLE customer_stats_daily (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    day_bucket DATE NOT NULL,

    -- Agent metrics
    total_agents INTEGER DEFAULT 0,
    active_agents INTEGER DEFAULT 0,

    -- Message metrics
    total_messages BIGINT DEFAULT 0,
    total_input_tokens BIGINT DEFAULT 0,
    total_output_tokens BIGINT DEFAULT 0,

    -- Cost estimation (based on token usage)
    estimated_cost_usd DECIMAL(10,4) DEFAULT 0,

    -- User metrics
    total_unique_users INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(customer_id, day_bucket)
);

-- Real-time message log (for recent activity, auto-pruned)
CREATE TABLE message_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    -- Message info
    direction VARCHAR(10) NOT NULL,  -- 'inbound', 'outbound'
    channel VARCHAR(50) NOT NULL,     -- 'telegram', etc.
    peer_id VARCHAR(255),

    -- Content (truncated for privacy)
    content_preview VARCHAR(500),

    -- Metrics
    input_tokens INTEGER,
    output_tokens INTEGER,
    response_time_ms INTEGER,

    -- Status
    status VARCHAR(50) DEFAULT 'success',  -- 'success', 'error', 'timeout'
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient time-based queries
CREATE INDEX idx_message_log_created ON message_log(created_at DESC);
CREATE INDEX idx_message_log_agent ON message_log(agent_id, created_at DESC);
CREATE INDEX idx_agent_stats_hourly_bucket ON agent_stats_hourly(hour_bucket DESC);
CREATE INDEX idx_customer_stats_daily_bucket ON customer_stats_daily(day_bucket DESC);

-- =============================================================================
-- BATCH OPERATIONS: Track preset updates to agents
-- =============================================================================

CREATE TABLE batch_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,

    operation_type VARCHAR(100) NOT NULL,  -- 'update_preset', 'apply_template', etc.
    target_scope VARCHAR(50) NOT NULL,     -- 'new_agents', 'existing_agents', 'all_agents'

    -- What was changed
    preset_type VARCHAR(50),  -- 'skill', 'soul', 'template'
    preset_id UUID,
    changes JSONB NOT NULL,

    -- Execution status
    status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
    affected_agent_ids UUID[] DEFAULT '{}',
    total_agents INTEGER DEFAULT 0,
    processed_agents INTEGER DEFAULT 0,
    failed_agents INTEGER DEFAULT 0,

    -- Error tracking
    errors JSONB DEFAULT '[]',

    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- SEED DATA: Default presets
-- =============================================================================

-- Default soul presets
INSERT INTO soul_presets (id, customer_id, name, slug, description, system_prompt, personality_traits, tone, is_default, is_locked, sort_order) VALUES
(gen_random_uuid(), NULL, 'Professional Assistant', 'professional-assistant', 'A professional, helpful AI assistant',
'You are a professional AI assistant. Be helpful, accurate, and concise. Always maintain a professional tone while being approachable.',
'["professional", "helpful", "accurate", "concise"]'::jsonb, 'professional', true, true, 1),

(gen_random_uuid(), NULL, 'Friendly Helper', 'friendly-helper', 'A warm, friendly conversational assistant',
'You are a friendly AI helper. Be warm, encouraging, and supportive. Use casual language while remaining helpful and informative.',
'["friendly", "warm", "encouraging", "supportive"]'::jsonb, 'casual', false, true, 2),

(gen_random_uuid(), NULL, 'Technical Expert', 'technical-expert', 'A technical expert for developer support',
'You are a technical expert assistant. Provide detailed, accurate technical information. Use code examples when helpful. Be precise and thorough.',
'["technical", "precise", "thorough", "knowledgeable"]'::jsonb, 'formal', false, true, 3),

(gen_random_uuid(), NULL, 'Customer Support', 'customer-support', 'Optimized for customer service interactions',
'You are a customer support agent. Be patient, empathetic, and solution-oriented. Always try to resolve issues efficiently while maintaining a positive experience.',
'["patient", "empathetic", "solution-oriented", "positive"]'::jsonb, 'friendly', false, true, 4),

(gen_random_uuid(), NULL, 'Minimal', 'minimal', 'Bare minimum configuration - no personality constraints',
'You are an AI assistant.',
'[]'::jsonb, 'neutral', false, true, 10);

-- Default skill presets
INSERT INTO skill_presets (id, customer_id, name, slug, description, icon, category, skill_type, prompt_template, is_default, is_locked, sort_order) VALUES
(gen_random_uuid(), NULL, 'Web Search', 'web-search', 'Search the web for current information', '🔍', 'research', 'prompt',
'When the user asks about current events or needs up-to-date information, acknowledge that you can search the web to find accurate information.',
true, true, 1),

(gen_random_uuid(), NULL, 'Code Helper', 'code-helper', 'Help with programming and code review', '💻', 'development', 'prompt',
'You can help with programming tasks including code review, debugging, explaining code, and writing new code. Always use proper formatting for code blocks.',
false, true, 2),

(gen_random_uuid(), NULL, 'Data Analysis', 'data-analysis', 'Analyze data and create insights', '📊', 'analysis', 'prompt',
'You can help analyze data, identify patterns, and provide insights. Ask clarifying questions about the data format and desired output.',
false, true, 3),

(gen_random_uuid(), NULL, 'Creative Writing', 'creative-writing', 'Help with creative content', '✍️', 'creative', 'prompt',
'You can help with creative writing tasks including stories, poems, scripts, and other creative content. Be imaginative while following any specified guidelines.',
false, true, 4),

(gen_random_uuid(), NULL, 'Translation', 'translation', 'Translate between languages', '🌐', 'language', 'prompt',
'You can translate text between languages. Always confirm the target language and maintain the original meaning and tone.',
false, true, 5),

(gen_random_uuid(), NULL, 'Summarization', 'summarization', 'Summarize long content', '📝', 'productivity', 'prompt',
'You can summarize long documents, articles, or conversations. Provide concise summaries while capturing key points.',
true, true, 6),

(gen_random_uuid(), NULL, 'Q&A Mode', 'qa-mode', 'Answer questions directly and concisely', '❓', 'general', 'prompt',
'Focus on answering questions directly and concisely. Provide clear, factual answers without unnecessary elaboration.',
false, true, 7),

(gen_random_uuid(), NULL, 'Brainstorming', 'brainstorming', 'Generate ideas and suggestions', '💡', 'creative', 'prompt',
'Help generate ideas, suggestions, and alternatives. Be creative and think outside the box while remaining relevant to the topic.',
false, true, 8);

-- Default platform config
INSERT INTO platform_config (key, value, description) VALUES
('default_model', '"claude-sonnet-4-20250514"', 'Default model for new agents'),
('allowed_models', '["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-3-5-20241022"]', 'Models available for selection'),
('max_system_prompt_length', '50000', 'Maximum characters for system prompt'),
('max_tokens_limit', '8192', 'Maximum tokens allowed'),
('default_rate_limits', '{"free": {"messages_per_day": 100}, "pro": {"messages_per_day": 1000}, "enterprise": {"messages_per_day": 10000}}', 'Rate limits by plan'),
('token_costs', '{"claude-sonnet-4-20250514": {"input": 0.003, "output": 0.015}, "claude-opus-4-20250514": {"input": 0.015, "output": 0.075}, "claude-haiku-3-5-20241022": {"input": 0.00025, "output": 0.00125}}', 'Cost per 1K tokens in USD'),
('features', '{"webhooks": true, "custom_skills": false, "api_access": true}', 'Feature flags'),
('maintenance_mode', 'false', 'Enable maintenance mode'),
('announcement', 'null', 'Platform-wide announcement message');

-- =============================================================================
-- FUNCTIONS: Auto-update timestamps
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_skill_presets_updated_at BEFORE UPDATE ON skill_presets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_soul_presets_updated_at BEFORE UPDATE ON soul_presets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_agent_templates_updated_at BEFORE UPDATE ON agent_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_platform_config_updated_at BEFORE UPDATE ON platform_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customer_config_updated_at BEFORE UPDATE ON customer_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
