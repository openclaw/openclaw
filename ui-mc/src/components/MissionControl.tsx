/**
 * REAL Mavis Mission Control
 * Direct OpenClaw connection with agency-agents integration
 * PWA-ready, real data, no simulation
 */

import { useEffect, useState } from 'react';
import { gateway, type AgentInfo, type ConnectionStatus } from '@/lib/gateway';
import { AgentCard } from './AgentCard';
import { StatusHeader } from './StatusHeader';

// Agency Agents mapping (61 agents from agency-agents repo)
const AGENCY_AGENTS = {
  // Engineering Division (8 agents)
  'frontend-dev': { name: 'Frontend Developer', emoji: '🎨', role: 'Engineering', division: 'engineering' },
  'backend-arch': { name: 'Backend Architect', emoji: '🏗️', role: 'Engineering', division: 'engineering' },
  'mobile-dev': { name: 'Mobile App Builder', emoji: '📱', role: 'Engineering', division: 'engineering' },
  'ai-engineer': { name: 'AI Engineer', emoji: '🤖', role: 'Engineering', division: 'engineering' },
  'devops-auto': { name: 'DevOps Automator', emoji: '🚀', role: 'Engineering', division: 'engineering' },
  'rapid-proto': { name: 'Rapid Prototyper', emoji: '⚡', role: 'Engineering', division: 'engineering' },
  'senior-dev': { name: 'Senior Developer', emoji: '💎', role: 'Engineering', division: 'engineering' },
  'security-eng': { name: 'Security Engineer', emoji: '🔒', role: 'Engineering', division: 'engineering' },
  
  // Design Division (7 agents)
  'ui-designer': { name: 'UI Designer', emoji: '🎯', role: 'Design', division: 'design' },
  'ux-researcher': { name: 'UX Researcher', emoji: '🔍', role: 'Design', division: 'design' },
  'ux-architect': { name: 'UX Architect', emoji: '🏛️', role: 'Design', division: 'design' },
  'brand-guard': { name: 'Brand Guardian', emoji: '🎭', role: 'Design', division: 'design' },
  'visual-story': { name: 'Visual Storyteller', emoji: '📖', role: 'Design', division: 'design' },
  'whimsy-inject': { name: 'Whimsy Injector', emoji: '✨', role: 'Design', division: 'design' },
  'image-prompt': { name: 'Image Prompt Engineer', emoji: '📷', role: 'Design', division: 'design' },
  
  // Marketing Division (11 agents)
  'growth-hacker': { name: 'Growth Hacker', emoji: '🚀', role: 'Marketing', division: 'marketing' },
  'content-creator': { name: 'Content Creator', emoji: '📝', role: 'Marketing', division: 'marketing' },
  'twitter-engager': { name: 'Twitter Engager', emoji: '🐦', role: 'Marketing', division: 'marketing' },
  'tiktok-strat': { name: 'TikTok Strategist', emoji: '📱', role: 'Marketing', division: 'marketing' },
  'instagram-cur': { name: 'Instagram Curator', emoji: '📸', role: 'Marketing', division: 'marketing' },
  'reddit-builder': { name: 'Reddit Community Builder', emoji: '🤝', role: 'Marketing', division: 'marketing' },
  'app-store-opt': { name: 'App Store Optimizer', emoji: '📱', role: 'Marketing', division: 'marketing' },
  'social-media': { name: 'Social Media Strategist', emoji: '🌐', role: 'Marketing', division: 'marketing' },
  'xiaohongshu': { name: 'Xiaohongshu Specialist', emoji: '📕', role: 'Marketing', division: 'marketing' },
  'wechat-mgr': { name: 'WeChat Official Account Manager', emoji: '💬', role: 'Marketing', division: 'marketing' },
  'zhihu-strat': { name: 'Zhihu Strategist', emoji: '🧠', role: 'Marketing', division: 'marketing' },
  
  // Product Division (3 agents)
  'sprint-prior': { name: 'Sprint Prioritizer', emoji: '🎯', role: 'Product', division: 'product' },
  'trend-research': { name: 'Trend Researcher', emoji: '🔍', role: 'Product', division: 'product' },
  'feedback-synth': { name: 'Feedback Synthesizer', emoji: '💬', role: 'Product', division: 'product' },
  
  // Project Management (5 agents)
  'studio-prod': { name: 'Studio Producer', emoji: '🎬', role: 'Project Management', division: 'project-management' },
  'project-shep': { name: 'Project Shepherd', emoji: '🐑', role: 'Project Management', division: 'project-management' },
  'studio-ops': { name: 'Studio Operations', emoji: '⚙️', role: 'Project Management', division: 'project-management' },
  'experiment-track': { name: 'Experiment Tracker', emoji: '🧪', role: 'Project Management', division: 'project-management' },
  'senior-pm': { name: 'Senior Project Manager', emoji: '👔', role: 'Project Management', division: 'project-management' },
  
  // Testing Division (8 agents)
  'evidence-collect': { name: 'Evidence Collector', emoji: '📸', role: 'Testing', division: 'testing' },
  'reality-check': { name: 'Reality Checker', emoji: '🔍', role: 'Testing', division: 'testing' },
  'test-analyzer': { name: 'Test Results Analyzer', emoji: '📊', role: 'Testing', division: 'testing' },
  'perf-benchmark': { name: 'Performance Benchmarker', emoji: '⚡', role: 'Testing', division: 'testing' },
  'api-tester': { name: 'API Tester', emoji: '🔌', role: 'Testing', division: 'testing' },
  'tool-evaluator': { name: 'Tool Evaluator', emoji: '🛠️', role: 'Testing', division: 'testing' },
  'workflow-opt': { name: 'Workflow Optimizer', emoji: '🔄', role: 'Testing', division: 'testing' },
  'accessibility-audit': { name: 'Accessibility Auditor', emoji: '♿', role: 'Testing', division: 'testing' },
  
  // Support Division (6 agents)
  'support-respond': { name: 'Support Responder', emoji: '💬', role: 'Support', division: 'support' },
  'analytics-rep': { name: 'Analytics Reporter', emoji: '📊', role: 'Support', division: 'support' },
  'finance-track': { name: 'Finance Tracker', emoji: '💰', role: 'Support', division: 'support' },
  'infra-maintain': { name: 'Infrastructure Maintainer', emoji: '🏗️', role: 'Support', division: 'support' },
  'legal-compliance': { name: 'Legal Compliance Checker', emoji: '⚖️', role: 'Support', division: 'support' },
  'exec-summary': { name: 'Executive Summary Generator', emoji: '📑', role: 'Support', division: 'support' },
  
  // Spatial Computing (6 agents)
  'xr-architect': { name: 'XR Interface Architect', emoji: '🏗️', role: 'Spatial Computing', division: 'spatial-computing' },
  'macos-spatial': { name: 'macOS Spatial/Metal Engineer', emoji: '💻', role: 'Spatial Computing', division: 'spatial-computing' },
  'xr-immersive': { name: 'XR Immersive Developer', emoji: '🌐', role: 'Spatial Computing', division: 'spatial-computing' },
  'xr-cockpit': { name: 'XR Cockpit Interaction Specialist', emoji: '🎮', role: 'Spatial Computing', division: 'spatial-computing' },
  'visionos-spatial': { name: 'visionOS Spatial Engineer', emoji: '🍎', role: 'Spatial Computing', division: 'spatial-computing' },
  'terminal-integ': { name: 'Terminal Integration Specialist', emoji: '🔌', role: 'Spatial Computing', division: 'spatial-computing' },
  
  // Specialized (8 agents)
  'agents-orchestrator': { name: 'Agents Orchestrator', emoji: '🎭', role: 'Specialized', division: 'specialized' },
  'data-analytics': { name: 'Data Analytics Reporter', emoji: '📊', role: 'Specialized', division: 'specialized' },
  'lsp-engineer': { name: 'LSP/Index Engineer', emoji: '🔍', role: 'Specialized', division: 'specialized' },
  'sales-extract': { name: 'Sales Data Extraction Agent', emoji: '📥', role: 'Specialized', division: 'specialized' },
  'data-consolidate': { name: 'Data Consolidation Agent', emoji: '📈', role: 'Specialized', division: 'specialized' },
  'report-distribute': { name: 'Report Distribution Agent', emoji: '📬', role: 'Specialized', division: 'specialized' },
  'agentic-identity': { name: 'Agentic Identity & Trust Architect', emoji: '🔐', role: 'Specialized', division: 'specialized' },
};

function getGwHost() {
  const params = new URLSearchParams(window.location.search);
  return params.get('gwHost') || '127.0.0.1:18789';
}

export default function MissionControl() {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeDivision, setActiveDivision] = useState<string>('all');
  const gwHost = getGwHost();

  // Initialize agents with agency-agents
  useEffect(() => {
    const initialAgents: AgentInfo[] = Object.entries(AGENCY_AGENTS).map(([id, meta]) => ({
      id,
      name: meta.name,
      emoji: meta.emoji,
      role: meta.role,
      status: 'unknown',
      division: meta.division,
    }));

    // Add core OpenClaw agents
    const coreAgents: AgentInfo[] = [
      { id: 'main', name: 'Mavis', emoji: '🦾', role: 'Assistant', status: 'unknown', division: 'core' },
      { id: 'security-1', name: 'Security Audit', emoji: '🔍', role: 'Security', status: 'unknown', division: 'core' },
      { id: 'security-2', name: 'API Permissions', emoji: '🔐', role: 'Security', status: 'unknown', division: 'core' },
      { id: 'security-3', name: 'Data Privacy', emoji: '🛡️', role: 'Security', status: 'unknown', division: 'core' },
      { id: 'trading-research', name: 'Trading Research', emoji: '📈', role: 'Trading', status: 'unknown', division: 'core' },
      { id: 'trading-bitcoin', name: 'Bitcoin Analyst', emoji: '₿', role: 'Trading', status: 'unknown', division: 'core' },
      { id: 'content-creator', name: 'Content Creator', emoji: '✍️', role: 'Content', status: 'unknown', division: 'core' },
      { id: 'content-poster', name: 'Content Poster', emoji: '📤', role: 'Content', status: 'unknown', division: 'core' },
      { id: 'ops-builder', name: 'Ops Builder', emoji: '🛠️', role: 'Operations', status: 'unknown', division: 'core' },
      { id: 'scheduler', name: 'Scheduler', emoji: '📅', role: 'Operations', status: 'unknown', division: 'core' },
      { id: 'pattern-tracker', name: 'Pattern Tracker', emoji: '🔮', role: 'Analytics', status: 'unknown', division: 'core' },
    ];

    setAgents([...coreAgents, ...initialAgents]);
  }, []);

  // Connect to OpenClaw
  useEffect(() => {
    gateway.onStatusChange = setStatus;
    gateway.onAgentsChange = (serverAgents) => {
      // Merge server status with our agent list
      setAgents(currentAgents => 
        currentAgents.map(agent => {
          const serverAgent = serverAgents.find(sa => sa.id === agent.id);
          if (serverAgent) {
            return { ...agent, status: serverAgent.status, model: serverAgent.model };
          }
          return agent;
        })
      );
    };
    
    gateway.init();
    
    return () => {
      gateway.onStatusChange = undefined;
      gateway.onAgentsChange = undefined;
    };
  }, []);

  const onlineCount = agents.filter(a => a.status === 'online' || a.status === 'busy').length;
  const totalAgents = agents.length;

  const handleRefresh = () => {
    setStatus('connecting');
    gateway.connect();
  };

  const selectedAgent = selected ? agents.find(a => a.id === selected) : null;

  // Filter agents by division
  const filteredAgents = activeDivision === 'all' 
    ? agents 
    : agents.filter(agent => agent.division === activeDivision);

  // Get unique divisions
  const divisions = Array.from(new Set(agents.map(a => a.division))).sort();

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-black text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-r from-purple-600 to-blue-500 rounded-lg flex items-center justify-center">
              <span className="text-2xl">🦾</span>
            </div>
            <div>
              <h1 className="text-2xl font-bold">Mavis Mission Control</h1>
              <p className="text-sm text-gray-400">Real OpenClaw integration with 61 agency-agents</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-sm text-gray-400">Gateway</div>
              <div className="font-mono text-sm">{gwHost}</div>
            </div>
            <button
              onClick={handleRefresh}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors flex items-center gap-2"
            >
              <span className={status === 'connected' ? 'text-green-400' : status === 'error' ? 'text-red-400' : 'text-yellow-400'}>
                ●
              </span>
              {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Stats Bar */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
            <div className="text-3xl font-bold">{totalAgents}</div>
            <div className="text-sm text-gray-400">Total Agents</div>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
            <div className="text-3xl font-bold text-green-400">{onlineCount}</div>
            <div className="text-sm text-gray-400">Active Agents</div>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
            <div className="text-3xl font-bold">{divisions.length}</div>
            <div className="text-sm text-gray-400">Divisions</div>
          </div>
          <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 border border-gray-700">
            <div className="text-3xl font-bold">PWA</div>
            <div className="text-sm text-gray-400">Ready to Install</div>
          </div>
        </div>

        {/* Division Filter */}
        <div className="mb-8">
          <h2 className="text-xl font-bold mb-4">Agent Divisions</h2>
          <div className="flex flex-wrap gap-2">
            <button
              onClick