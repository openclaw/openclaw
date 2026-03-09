import { motion } from "framer-motion";
import { BookOpen, Zap, Rocket, Wrench, Copy, Check, ChevronRight } from "lucide-react";
import { useState } from "react";

type PlaybookMode = "full" | "sprint" | "micro";

interface Workflow {
  id: string;
  title: string;
  subtitle: string;
  agents: string[];
  duration: string;
  steps: { label: string; prompt: string }[];
}

const NEXUS_MODES = [
  {
    id: "full" as PlaybookMode,
    label: "NEXUS-Full",
    icon: Rocket,
    description: "Complete product from scratch",
    agents: "All agents",
    time: "12–24 weeks",
    color: "#8B5CF6",
    phases: [
      {
        id: "P0",
        name: "Discovery",
        agents: [
          "Trend Researcher",
          "Feedback Synthesizer",
          "UX Researcher",
          "Analytics Reporter",
          "Legal Compliance Checker",
          "Tool Evaluator",
        ],
      },
      {
        id: "P1",
        name: "Strategy",
        agents: [
          "Studio Producer",
          "Senior PM",
          "Sprint Prioritizer",
          "UX Architect",
          "Brand Guardian",
          "Backend Architect",
          "Finance Tracker",
        ],
      },
      {
        id: "P2",
        name: "Foundation",
        agents: [
          "DevOps Automator",
          "Frontend Dev",
          "Backend Architect",
          "UX Architect",
          "Infrastructure Maintainer",
        ],
      },
      { id: "P3", name: "Build", agents: ["All Engineering", "Evidence Collector", "API Tester"] },
      {
        id: "P4",
        name: "Harden",
        agents: [
          "Reality Checker",
          "Performance Benchmarker",
          "API Tester",
          "Legal Compliance Checker",
          "Accessibility Auditor",
        ],
      },
      {
        id: "P5",
        name: "Launch",
        agents: ["Growth Hacker", "Content Creator", "All Marketing", "DevOps Automator"],
      },
      {
        id: "P6",
        name: "Operate",
        agents: ["Analytics Reporter", "Infrastructure Maintainer", "Support Responder"],
      },
    ],
    prompt: `Activate Agents Orchestrator in NEXUS-Full mode.

Project: [YOUR PROJECT NAME]
Specification: [DESCRIBE YOUR PROJECT OR LINK TO SPEC]

Execute the complete NEXUS pipeline:
- Phase 0: Discovery (Trend Researcher, Feedback Synthesizer, UX Researcher, Analytics Reporter, Legal Compliance Checker, Tool Evaluator)
- Phase 1: Strategy (Studio Producer, Senior Project Manager, Sprint Prioritizer, UX Architect, Brand Guardian, Backend Architect, Finance Tracker)
- Phase 2: Foundation (DevOps Automator, Frontend Developer, Backend Architect, UX Architect, Infrastructure Maintainer)
- Phase 3: Build (Dev↔QA loops — all engineering + Evidence Collector)
- Phase 4: Harden (Reality Checker, Performance Benchmarker, API Tester, Legal Compliance Checker)
- Phase 5: Launch (Growth Hacker, Content Creator, all marketing agents, DevOps Automator)
- Phase 6: Operate (Analytics Reporter, Infrastructure Maintainer, Support Responder, ongoing)

Quality gates between every phase. Evidence required for all assessments.
Maximum 3 retries per task before escalation.`,
  },
  {
    id: "sprint" as PlaybookMode,
    label: "NEXUS-Sprint",
    icon: Zap,
    description: "Feature or MVP build",
    agents: "15–25 agents",
    time: "2–6 weeks",
    color: "#06B6D4",
    phases: [
      { id: "PM", name: "Planning", agents: ["Senior PM", "Sprint Prioritizer"] },
      { id: "DX", name: "Design", agents: ["UX Architect", "Brand Guardian", "UI Designer"] },
      {
        id: "ENG",
        name: "Engineering",
        agents: ["Frontend Dev", "Backend Architect", "DevOps Automator"],
      },
      { id: "QA", name: "Quality", agents: ["Reality Checker", "Evidence Collector"] },
    ],
    prompt: `Activate Agents Orchestrator in NEXUS-Sprint mode.

Feature/MVP: [DESCRIBE WHAT YOU'RE BUILDING]
Timeline: [TARGET WEEKS]
Skip Phase 0 (market already validated).

Sprint team:
- PM: Senior Project Manager, Sprint Prioritizer
- Design: UX Architect, Brand Guardian, UI Designer
- Engineering: Frontend Developer, Backend Architect, DevOps Automator
- QA: Evidence Collector, Reality Checker

Deliver working software with quality gates at each sprint.`,
  },
  {
    id: "micro" as PlaybookMode,
    label: "NEXUS-Micro",
    icon: Wrench,
    description: "Specific task or bug fix",
    agents: "5–10 agents",
    time: "1–5 days",
    color: "#22C55E",
    phases: [
      { id: "SCOPE", name: "Scope", agents: ["Senior PM"] },
      { id: "EXE", name: "Execute", agents: ["Relevant specialist"] },
      { id: "VERIFY", name: "Verify", agents: ["Reality Checker", "Evidence Collector"] },
    ],
    prompt: `Activate Agents Orchestrator in NEXUS-Micro mode.

Task: [DESCRIBE THE SPECIFIC TASK]
Scope: [WHAT IS IN / OUT OF SCOPE]

Micro team — pick the relevant specialists:
- Scoping: Senior Project Manager
- Execution: [Pick the right specialist agent]
- Verification: Reality Checker, Evidence Collector

No retries without explicit approval.
Deliver working output within [DAYS] days.`,
  },
];

const WORKFLOWS: Workflow[] = [
  {
    id: "startup-mvp",
    title: "Startup MVP",
    subtitle: "Go from idea to shipped MVP in 4 weeks",
    duration: "4 weeks",
    agents: [
      "Sprint Prioritizer",
      "UX Researcher",
      "Backend Architect",
      "Frontend Developer",
      "Rapid Prototyper",
      "Growth Hacker",
      "Reality Checker",
    ],
    steps: [
      {
        label: "Step 1: Activate Sprint Prioritizer",
        prompt: `Activate Sprint Prioritizer.

Project: [YOUR APP NAME] — [ONE LINE DESCRIPTION].
Timeline: 4 weeks to MVP launch.
Core features: [LIST 3-5 CORE FEATURES].
Constraints: [YOUR STACK AND DEPLOY TARGET].

Break this into 4 weekly sprints with clear deliverables and acceptance criteria.`,
      },
      {
        label: "Step 2: UX Researcher (parallel)",
        prompt: `Activate UX Researcher.

Run 5 quick user interviews this week for [YOUR APP NAME].
Target users: [YOUR TARGET USER DESCRIPTION].
Validate: [KEY ASSUMPTION TO TEST].

Deliver: interview guide, 5 scheduled interviews, synthesis report.`,
      },
      {
        label: "Step 3: Backend Architect",
        prompt: `Activate Backend Architect.

Design API and data model for [YOUR APP NAME].
Core entities: [LIST MAIN DATA MODELS].
Stack: [YOUR BACKEND STACK].

Deliver: ERD, API spec (OpenAPI), auth strategy, deployment plan.`,
      },
      {
        label: "Step 4: Reality Checker (gate)",
        prompt: `Activate Reality Checker.

Review Week 1 deliverables for [YOUR APP NAME]:
- Sprint plan (attached)
- API spec (attached)
- UX research findings (attached)

Default to NEEDS WORK. Approve only with overwhelming evidence.`,
      },
    ],
  },
  {
    id: "landing-page",
    title: "Landing Page Sprint",
    subtitle: "Ship a conversion-optimized landing page in one day",
    duration: "1 day",
    agents: ["Content Creator", "UI Designer", "Frontend Developer", "Growth Hacker"],
    steps: [
      {
        label: "Step 1: Content Creator (morning)",
        prompt: `Activate Content Creator.

Write landing page copy for "[PRODUCT NAME]" — [ONE LINE DESCRIPTION].

Target audience: [YOUR TARGET USER].
Tone: [TONE].

Sections needed:
1. Hero (headline + subheadline + CTA)
2. Problem statement (3 pain points)
3. How it works (3 steps)
4. Social proof (placeholder format)
5. Pricing (3 tiers)
6. Final CTA`,
      },
      {
        label: "Step 2: UI Designer (morning, parallel)",
        prompt: `Activate UI Designer.

Design landing page layout for "[PRODUCT NAME]".
Brand: [BRAND COLORS AND STYLE].
Tech: React + Tailwind CSS.

Deliver: component breakdown, color/type specs, layout wireframe.`,
      },
      {
        label: "Step 3: Frontend Developer (afternoon)",
        prompt: `Activate Frontend Developer.

Build landing page for "[PRODUCT NAME]" using the copy and design specs (attached).
Stack: React + Tailwind CSS.
Deploy: [YOUR PLATFORM].

Requirements: responsive, fast load, accessible, CTA tracking.`,
      },
      {
        label: "Step 4: Growth Hacker (review)",
        prompt: `Activate Growth Hacker.

Review landing page for "[PRODUCT NAME]" (URL: [YOUR URL]).

Optimize for conversion:
- CTA placement and copy
- Social proof positioning
- Form friction reduction
- A/B test recommendations

Deliver: specific changes with expected conversion impact.`,
      },
    ],
  },
  {
    id: "marketing-campaign",
    title: "Marketing Campaign",
    subtitle: "Multi-channel launch campaign with full content suite",
    duration: "1–2 weeks",
    agents: [
      "Content Creator",
      "Social Media Strategist",
      "Twitter Engager",
      "Growth Hacker",
      "Analytics Reporter",
    ],
    steps: [
      {
        label: "Step 1: Social Media Strategist",
        prompt: `Activate Social Media Strategist.

Plan multi-channel campaign for [PRODUCT/LAUNCH NAME].
Channels: [SELECT: Twitter, LinkedIn, Instagram, TikTok, Reddit].
Duration: [CAMPAIGN LENGTH].
Goal: [PRIMARY GOAL: awareness / signups / downloads].

Deliver: campaign calendar, content mix, KPIs, engagement tactics.`,
      },
      {
        label: "Step 2: Content Creator",
        prompt: `Activate Content Creator.

Create content suite for [PRODUCT/LAUNCH NAME] campaign.
Reference: campaign strategy (attached).
Volume: 5 Twitter threads, 3 LinkedIn posts, 2 Instagram captions, 1 launch blog post.

Match brand voice: [YOUR BRAND VOICE].`,
      },
      {
        label: "Step 3: Analytics Reporter (post-launch)",
        prompt: `Activate Analytics Reporter.

Analyze first 48 hours of [CAMPAIGN NAME] campaign.
Metrics to pull: [YOUR ANALYTICS SOURCES].
KPIs: [FROM CAMPAIGN STRATEGY].

Deliver: performance dashboard, what's working, what to double down on.`,
      },
    ],
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-text-2 hover:text-foreground transition-all border border-white/5"
    >
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function PlaybooksPage() {
  const [activeMode, setActiveMode] = useState<PlaybookMode>("sprint");
  const [expandedWorkflow, setExpandedWorkflow] = useState<string | null>("startup-mvp");
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  const mode = NEXUS_MODES.find((m) => m.id === activeMode);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="glass-panel p-6">
        <div className="flex items-center gap-3 mb-1">
          <BookOpen className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">NEXUS Playbooks</h1>
        </div>
        <p className="text-text-2 text-sm">
          Network of EXperts, Unified in Strategy — multi-agent orchestration playbooks and workflow
          templates.
        </p>
      </div>

      {/* NEXUS Modes */}
      <div>
        <h2 className="text-sm font-semibold text-text-2 uppercase tracking-wider mb-3">
          Deployment Modes
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {NEXUS_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setActiveMode(m.id)}
              className={`p-4 rounded-xl border text-left transition-all ${
                activeMode === m.id
                  ? "border-opacity-50"
                  : "border-white/5 bg-white/[0.02] hover:bg-white/5"
              }`}
              style={
                activeMode === m.id
                  ? { borderColor: `${m.color}50`, backgroundColor: `${m.color}10` }
                  : {}
              }
            >
              <div className="flex items-center gap-2 mb-2">
                <m.icon className="w-4 h-4" style={{ color: m.color }} />
                <span className="font-semibold text-sm text-foreground">{m.label}</span>
              </div>
              <p className="text-xs text-text-2 mb-2">{m.description}</p>
              <div className="flex items-center gap-2 text-xs text-text-2">
                <span style={{ color: m.color }}>{m.agents}</span>
                <span>·</span>
                <span>{m.time}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Active Mode Detail */}
      <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-foreground">{mode.label} Pipeline</h3>
          <CopyButton text={mode.prompt} />
        </div>

        {/* Phase pipeline */}
        <div className="flex flex-wrap gap-2 mb-4">
          {mode.phases.map((phase, i) => (
            <div key={phase.id} className="flex items-center gap-1">
              <div
                className="text-xs px-2.5 py-1.5 rounded-lg border"
                style={{
                  backgroundColor: `${mode.color}15`,
                  borderColor: `${mode.color}30`,
                  color: mode.color,
                }}
              >
                <span className="font-mono font-bold">{phase.id}</span>
                <span className="ml-1">{phase.name}</span>
              </div>
              {i < mode.phases.length - 1 && (
                <ChevronRight className="w-3 h-3 text-text-2 shrink-0" />
              )}
            </div>
          ))}
        </div>

        {/* Agents per phase */}
        <div className="space-y-2 mb-4">
          {mode.phases.map((phase) => (
            <div key={phase.id} className="flex items-start gap-3 text-xs">
              <span className="font-mono text-text-2 w-12 shrink-0 pt-0.5">{phase.id}</span>
              <div className="flex flex-wrap gap-1">
                {phase.agents.map((a) => (
                  <span key={a} className="px-1.5 py-0.5 rounded bg-white/5 text-text-2">
                    {a}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Activation prompt */}
        <div className="rounded-xl bg-black/30 border border-white/5 p-4">
          <p className="text-xs text-text-2 mb-2 font-semibold">Activation Prompt</p>
          <pre className="text-xs text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed">
            {mode.prompt}
          </pre>
        </div>
      </div>

      {/* Workflow Examples */}
      <div>
        <h2 className="text-sm font-semibold text-text-2 uppercase tracking-wider mb-3">
          Workflow Examples
        </h2>
        <div className="space-y-3">
          {WORKFLOWS.map((wf) => (
            <div
              key={wf.id}
              className="rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden"
            >
              <button
                onClick={() => setExpandedWorkflow(expandedWorkflow === wf.id ? null : wf.id)}
                className="w-full flex items-center gap-4 px-5 py-4 hover:bg-white/5 transition-colors text-left"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-semibold text-foreground">{wf.title}</span>
                    <span className="text-xs text-text-2 px-2 py-0.5 rounded-md bg-white/5">
                      {wf.duration}
                    </span>
                  </div>
                  <p className="text-sm text-text-2">{wf.subtitle}</p>
                </div>
                <div className="flex flex-wrap gap-1 max-w-xs">
                  {wf.agents.slice(0, 4).map((a) => (
                    <span key={a} className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-text-2">
                      {a}
                    </span>
                  ))}
                  {wf.agents.length > 4 && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-text-2">
                      +{wf.agents.length - 4}
                    </span>
                  )}
                </div>
              </button>

              {expandedWorkflow === wf.id && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="px-5 pb-5 space-y-3"
                >
                  {wf.steps.map((step, i) => (
                    <div
                      key={i}
                      className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden"
                    >
                      <button
                        onClick={() =>
                          setExpandedStep(expandedStep === `${wf.id}-${i}` ? null : `${wf.id}-${i}`)
                        }
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left"
                      >
                        <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center font-bold shrink-0">
                          {i + 1}
                        </span>
                        <span className="text-sm font-medium text-foreground flex-1">
                          {step.label}
                        </span>
                        <CopyButton text={step.prompt} />
                      </button>
                      {expandedStep === `${wf.id}-${i}` && (
                        <div className="px-4 pb-4">
                          <pre className="text-xs text-foreground/70 whitespace-pre-wrap font-mono leading-relaxed bg-black/30 rounded-lg p-3 border border-white/5">
                            {step.prompt}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </motion.div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
