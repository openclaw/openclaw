export type AgentStatus = "WORKING" | "IDLE" | "THINKING" | "DONE" | "ERROR";

export type AgentDivision =
  | "Core"
  | "Engineering"
  | "Design"
  | "Marketing"
  | "Product"
  | "Project Management"
  | "Testing"
  | "Support"
  | "Spatial Computing"
  | "Specialized";

export interface Agent {
  id: string;
  name: string;
  role: string;
  shortCode: string;
  avatar: string;
  color: string;
  status: AgentStatus;
  currentTask: string;
  progress: number;
  tasksCompleted: number;
  tasksDone: number;
  capabilities: string[];
  division: AgentDivision;
  emoji: string;
  description?: string;
}

// Color map for agent division theming
export const DIVISION_COLORS: Record<AgentDivision, string> = {
  Core: "#00C8FF",
  Engineering: "#06B6D4",
  Design: "#8B5CF6",
  Marketing: "#22C55E",
  Product: "#F97316",
  "Project Management": "#EAB308",
  Testing: "#EF4444",
  Support: "#14B8A6",
  "Spatial Computing": "#6366F1",
  Specialized: "#EC4899",
};

function base(): Omit<
  Agent,
  | "id"
  | "name"
  | "role"
  | "shortCode"
  | "avatar"
  | "color"
  | "division"
  | "emoji"
  | "description"
  | "capabilities"
> {
  return {
    status: "IDLE",
    currentTask: "Awaiting instructions",
    progress: 0,
    tasksCompleted: 0,
    tasksDone: 0,
  };
}

// Cycle through available agent avatar images
const AVATARS = ["aria", "vance", "dev", "echo", "flux", "nova", "sage", "ember"];
let _avatarIdx = 0;
function nextAvatar() {
  return `/agents/${AVATARS[_avatarIdx++ % AVATARS.length]}.png`;
}

export const AGENT_DEFINITIONS: Agent[] = [
  // ─── CORE (existing OpenClaw agents) ───────────────────────────────────────
  {
    ...base(),
    id: "main",
    name: "MAVIS",
    role: "Chief of Staff",
    shortCode: "M",
    avatar: "/agents/aria.png",
    color: "#00C8FF",
    division: "Core",
    emoji: "🦾",
    description:
      "Primary AI assistant and orchestrator. Coordinates all agents, manages schedules, and delegates tasks.",
    capabilities: ["Coordination", "Scheduling", "Delegation", "Reporting"],
  },
  {
    ...base(),
    id: "trading-bitcoin",
    name: "BITCOIN",
    role: "Bitcoin Analyst",
    shortCode: "B",
    avatar: "/agents/vance.png",
    color: "#FFD60A",
    division: "Core",
    emoji: "₿",
    description: "Specialist in Bitcoin market analysis, trading strategy, and price forecasting.",
    capabilities: ["Market Analysis", "Trading Strategy", "Risk Assessment", "Price Forecasting"],
  },
  {
    ...base(),
    id: "ops-builder",
    name: "BUILDER",
    role: "Ops Builder",
    shortCode: "O",
    avatar: "/agents/dev.png",
    color: "#30D158",
    division: "Core",
    emoji: "🛠️",
    description: "Builds automations, integrations, and internal tooling for operations.",
    capabilities: ["Automation", "Integration", "API Development", "Workflow Design"],
  },
  {
    ...base(),
    id: "content-creator",
    name: "CREATOR",
    role: "Content Creator",
    shortCode: "C",
    avatar: "/agents/echo.png",
    color: "#BF5AF2",
    division: "Core",
    emoji: "✍️",
    description:
      "Creates multi-platform content including writing, social media copy, SEO, and video scripts.",
    capabilities: ["Writing", "Social Media", "SEO", "Video Scripts"],
  },
  {
    ...base(),
    id: "content-poster",
    name: "POSTER",
    role: "Content Poster",
    shortCode: "P",
    avatar: "/agents/flux.png",
    color: "#FF2D55",
    division: "Core",
    emoji: "📤",
    description: "Handles content publishing, scheduling, and platform management.",
    capabilities: ["Publishing", "Scheduling", "Platform Management", "Engagement"],
  },
  {
    ...base(),
    id: "scheduler",
    name: "SCHEDULER",
    role: "Scheduler",
    shortCode: "S",
    avatar: "/agents/nova.png",
    color: "#FF9F0A",
    division: "Core",
    emoji: "📅",
    description: "Manages calendar, queues tasks, sets reminders, and optimizes time allocation.",
    capabilities: ["Calendar", "Task Queuing", "Reminders", "Time Optimization"],
  },
  {
    ...base(),
    id: "trading-research",
    name: "RESEARCH",
    role: "Trading Research",
    shortCode: "R",
    avatar: "/agents/sage.png",
    color: "#5E5CE6",
    division: "Core",
    emoji: "📈",
    description: "Market intelligence, data analysis, pattern recognition, and research reports.",
    capabilities: ["Market Intel", "Data Analysis", "Pattern Recognition", "Reports"],
  },
  {
    ...base(),
    id: "pattern-tracker",
    name: "TRACKER",
    role: "Pattern Tracker",
    shortCode: "T",
    avatar: "/agents/ember.png",
    color: "#FF6B35",
    division: "Core",
    emoji: "🔮",
    description: "Monitors behavioral patterns, detects anomalies, and tracks emerging trends.",
    capabilities: ["Behavioral Patterns", "Anomaly Detection", "Trend Monitoring", "Alerts"],
  },
  {
    ...base(),
    id: "security-1",
    name: "SENTINEL",
    role: "Security Audit",
    shortCode: "A",
    avatar: "/agents/dev.png",
    color: "#30D158",
    division: "Core",
    emoji: "🔍",
    description:
      "Conducts threat modeling, vulnerability assessment, OWASP audits, and secure code reviews.",
    capabilities: [
      "Threat Modeling",
      "Vulnerability Assessment",
      "OWASP Audits",
      "Secure Code Review",
    ],
  },
  {
    ...base(),
    id: "security-2",
    name: "PERMISSIONS",
    role: "API Permissions",
    shortCode: "K",
    avatar: "/agents/sage.png",
    color: "#5E5CE6",
    division: "Core",
    emoji: "🔐",
    description: "Manages IAM policy, API authorization, rate limiting, and access control.",
    capabilities: ["IAM Policy", "API Authorization", "Rate Limiting", "Access Control"],
  },
  {
    ...base(),
    id: "security-3",
    name: "PRIVACY",
    role: "Data Privacy",
    shortCode: "D",
    avatar: "/agents/aria.png",
    color: "#00C8FF",
    division: "Core",
    emoji: "🛡️",
    description: "Ensures data compliance, PII protection, encryption reviews, and privacy audits.",
    capabilities: ["Data Compliance", "PII Protection", "Encryption Review", "Privacy Audits"],
  },

  // ─── ENGINEERING ────────────────────────────────────────────────────────────
  {
    ...base(),
    id: "frontend-dev",
    name: "FRONTEND",
    role: "Frontend Developer",
    shortCode: "FE",
    avatar: nextAvatar(),
    color: "#06B6D4",
    division: "Engineering",
    emoji: "🖥️",
    description:
      "Expert frontend developer specializing in React/Vue/Angular frameworks, UI implementation, and performance optimization.",
    capabilities: ["React", "TypeScript", "Performance", "Accessibility"],
  },
  {
    ...base(),
    id: "backend-arch",
    name: "BACKEND",
    role: "Backend Architect",
    shortCode: "BE",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Engineering",
    emoji: "⚙️",
    description:
      "Senior backend architect specializing in scalable system design, database architecture, API development, and cloud infrastructure.",
    capabilities: ["System Design", "APIs", "Databases", "Cloud Infrastructure"],
  },
  {
    ...base(),
    id: "mobile-dev",
    name: "MOBILE",
    role: "Mobile App Builder",
    shortCode: "MB",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Engineering",
    emoji: "📱",
    description:
      "Specialized mobile application developer with expertise in native iOS/Android and cross-platform frameworks.",
    capabilities: ["iOS", "Android", "React Native", "Flutter"],
  },
  {
    ...base(),
    id: "ai-engineer",
    name: "AI ENG",
    role: "AI Engineer",
    shortCode: "AI",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Engineering",
    emoji: "🤖",
    description:
      "Expert AI/ML engineer specializing in machine learning model development, deployment, and integration into production systems.",
    capabilities: ["ML Models", "LLMs", "MLOps", "RAG Systems"],
  },
  {
    ...base(),
    id: "devops-auto",
    name: "DEVOPS",
    role: "DevOps Automator",
    shortCode: "DO",
    avatar: nextAvatar(),
    color: "#F97316",
    division: "Engineering",
    emoji: "🚀",
    description:
      "Expert DevOps engineer specializing in infrastructure automation, CI/CD pipeline development, and cloud operations.",
    capabilities: ["CI/CD", "Infrastructure", "Docker", "Kubernetes"],
  },
  {
    ...base(),
    id: "rapid-proto",
    name: "PROTO",
    role: "Rapid Prototyper",
    shortCode: "RP",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Engineering",
    emoji: "⚡",
    description:
      "Specialized in ultra-fast proof-of-concept development and MVP creation using efficient tools and frameworks.",
    capabilities: ["Rapid MVP", "Prototyping", "Proof of Concept", "Fast Iteration"],
  },
  {
    ...base(),
    id: "senior-dev",
    name: "SENIOR",
    role: "Senior Developer",
    shortCode: "SD",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Engineering",
    emoji: "👨‍💻",
    description:
      "Premium implementation specialist. Masters Laravel/Livewire/FluxUI, advanced CSS, Three.js integration.",
    capabilities: ["Laravel", "Livewire", "Three.js", "Advanced CSS"],
  },
  {
    ...base(),
    id: "security-eng",
    name: "SEC ENG",
    role: "Security Engineer",
    shortCode: "SE",
    avatar: nextAvatar(),
    color: "#EF4444",
    division: "Engineering",
    emoji: "🔒",
    description:
      "Expert application security engineer specializing in threat modeling, vulnerability assessment, and security architecture design.",
    capabilities: ["Threat Modeling", "OWASP", "Penetration Testing", "Secure Architecture"],
  },
  {
    ...base(),
    id: "technical-writer",
    name: "DOCS",
    role: "Technical Writer",
    shortCode: "TW",
    avatar: nextAvatar(),
    color: "#14B8A6",
    division: "Engineering",
    emoji: "📝",
    description:
      "Expert technical writer specializing in developer documentation, API references, README files, and tutorials.",
    capabilities: ["API Docs", "Tutorials", "README", "Developer Guides"],
  },
  {
    ...base(),
    id: "data-engineer",
    name: "DATA ENG",
    role: "Data Engineer",
    shortCode: "DE",
    avatar: nextAvatar(),
    color: "#F97316",
    division: "Engineering",
    emoji: "🗄️",
    description:
      "Expert data engineer specializing in reliable data pipelines, lakehouse architectures, and scalable data infrastructure.",
    capabilities: ["Data Pipelines", "ETL/ELT", "Apache Spark", "dbt"],
  },
  {
    ...base(),
    id: "auto-opt-arch",
    name: "OPTIMIZER",
    role: "Autonomous Optimization Architect",
    shortCode: "AO",
    avatar: nextAvatar(),
    color: "#673AB7",
    division: "Engineering",
    emoji: "🎯",
    description:
      "Intelligent system governor that continuously shadow-tests APIs for performance while enforcing strict financial and security guardrails.",
    capabilities: ["API Optimization", "Cost Guardrails", "Performance Testing", "Shadow Testing"],
  },

  // ─── DESIGN ─────────────────────────────────────────────────────────────────
  {
    ...base(),
    id: "brand-guard",
    name: "BRAND",
    role: "Brand Guardian",
    shortCode: "BG",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Design",
    emoji: "🎨",
    description:
      "Expert brand strategist and guardian specializing in brand identity development, consistency maintenance, and strategic brand positioning.",
    capabilities: ["Brand Identity", "Style Guides", "Consistency", "Positioning"],
  },
  {
    ...base(),
    id: "image-prompt",
    name: "IMAGER",
    role: "Image Prompt Engineer",
    shortCode: "IP",
    avatar: nextAvatar(),
    color: "#F59E0B",
    division: "Design",
    emoji: "🖼️",
    description:
      "Expert photography prompt engineer specializing in crafting detailed prompts for AI image generation with Midjourney, DALL-E, Stable Diffusion.",
    capabilities: ["Midjourney", "DALL-E", "Stable Diffusion", "Prompt Craft"],
  },
  {
    ...base(),
    id: "inclusive-visuals",
    name: "INCLUSIVE",
    role: "Inclusive Visuals Specialist",
    shortCode: "IV",
    avatar: nextAvatar(),
    color: "#4DB6AC",
    division: "Design",
    emoji: "🌈",
    description:
      "Representation expert who defeats systemic AI biases to generate culturally accurate, affirming, and non-stereotypical images and video.",
    capabilities: ["Bias Mitigation", "Cultural Accuracy", "Representation", "Inclusive Design"],
  },
  {
    ...base(),
    id: "ui-designer",
    name: "UI",
    role: "UI Designer",
    shortCode: "UI",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Design",
    emoji: "🎭",
    description:
      "Expert UI designer specializing in visual design systems, component libraries, and pixel-perfect interface creation.",
    capabilities: ["Design Systems", "Component Libraries", "Figma", "Visual Design"],
  },
  {
    ...base(),
    id: "ux-architect",
    name: "UX ARCH",
    role: "UX Architect",
    shortCode: "UA",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Design",
    emoji: "🏗️",
    description:
      "Technical architecture and UX specialist who provides developers with solid foundations, CSS systems, and clear implementation guidance.",
    capabilities: [
      "Information Architecture",
      "CSS Systems",
      "Wireframes",
      "Implementation Guidance",
    ],
  },
  {
    ...base(),
    id: "ux-researcher",
    name: "UX RES",
    role: "UX Researcher",
    shortCode: "UR",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Design",
    emoji: "🔬",
    description:
      "Expert user experience researcher specializing in user behavior analysis, usability testing, and data-driven design insights.",
    capabilities: ["User Testing", "Behavior Analysis", "Usability Studies", "Insights"],
  },
  {
    ...base(),
    id: "visual-story",
    name: "VISUAL",
    role: "Visual Storyteller",
    shortCode: "VS",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Design",
    emoji: "🎬",
    description:
      "Expert visual communication specialist creating compelling visual narratives, multimedia content, and brand storytelling through design.",
    capabilities: ["Visual Narratives", "Multimedia", "Brand Storytelling", "Motion"],
  },
  {
    ...base(),
    id: "whimsy-inject",
    name: "WHIMSY",
    role: "Whimsy Injector",
    shortCode: "WI",
    avatar: nextAvatar(),
    color: "#EC4899",
    division: "Design",
    emoji: "✨",
    description:
      "Expert creative specialist focused on adding personality, delight, and playful elements to brand experiences.",
    capabilities: ["Delight Design", "Micro-interactions", "Personality", "Playful UX"],
  },

  // ─── MARKETING ──────────────────────────────────────────────────────────────
  {
    ...base(),
    id: "app-store-opt",
    name: "ASO",
    role: "App Store Optimizer",
    shortCode: "AS",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Marketing",
    emoji: "📦",
    description:
      "Expert app store marketing specialist focused on App Store Optimization (ASO), conversion rate optimization, and app discoverability.",
    capabilities: ["ASO", "Keyword Strategy", "Store Listings", "Conversion Optimization"],
  },
  {
    ...base(),
    id: "growth-hacker",
    name: "GROWTH",
    role: "Growth Hacker",
    shortCode: "GH",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Marketing",
    emoji: "📊",
    description:
      "Expert growth strategist specializing in rapid user acquisition through data-driven experimentation and viral loops.",
    capabilities: ["User Acquisition", "Viral Loops", "Conversion Funnels", "A/B Testing"],
  },
  {
    ...base(),
    id: "instagram-cur",
    name: "INSTAGRAM",
    role: "Instagram Curator",
    shortCode: "IG",
    avatar: nextAvatar(),
    color: "#E4405F",
    division: "Marketing",
    emoji: "📸",
    description:
      "Expert Instagram marketing specialist focused on visual storytelling, community building, and multi-format content optimization.",
    capabilities: ["Visual Content", "Reels", "Community Building", "Hashtag Strategy"],
  },
  {
    ...base(),
    id: "reddit-builder",
    name: "REDDIT",
    role: "Reddit Community Builder",
    shortCode: "RB",
    avatar: nextAvatar(),
    color: "#FF4500",
    division: "Marketing",
    emoji: "🧵",
    description:
      "Expert Reddit marketing specialist focused on authentic community engagement, value-driven content creation, and long-term relationship building.",
    capabilities: ["Community Engagement", "Authentic Content", "Subreddit Strategy", "AMAs"],
  },
  {
    ...base(),
    id: "social-media",
    name: "SOCIAL",
    role: "Social Media Strategist",
    shortCode: "SM",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Marketing",
    emoji: "📣",
    description:
      "Expert social media strategist for LinkedIn, Twitter, and professional platforms. Creates cross-platform campaigns and builds communities.",
    capabilities: [
      "Cross-platform Campaigns",
      "Community Management",
      "Thought Leadership",
      "Analytics",
    ],
  },
  {
    ...base(),
    id: "tiktok-strat",
    name: "TIKTOK",
    role: "TikTok Strategist",
    shortCode: "TT",
    avatar: nextAvatar(),
    color: "#6E6E8E",
    division: "Marketing",
    emoji: "🎵",
    description:
      "Expert TikTok marketing specialist focused on viral content creation, algorithm optimization, and community building.",
    capabilities: ["Viral Content", "TikTok Algorithm", "Trends", "Short-form Video"],
  },
  {
    ...base(),
    id: "twitter-engager",
    name: "TWITTER",
    role: "Twitter Engager",
    shortCode: "TW",
    avatar: nextAvatar(),
    color: "#1DA1F2",
    division: "Marketing",
    emoji: "🐦",
    description:
      "Expert Twitter marketing specialist focused on real-time engagement, thought leadership building, and community-driven growth.",
    capabilities: ["Thread Writing", "Real-time Engagement", "Trending Topics", "Brand Voice"],
  },
  {
    ...base(),
    id: "wechat-mgr",
    name: "WECHAT",
    role: "WeChat Account Manager",
    shortCode: "WC",
    avatar: nextAvatar(),
    color: "#09B83E",
    division: "Marketing",
    emoji: "💬",
    description:
      "Expert WeChat Official Account strategist specializing in content marketing, subscriber engagement, and conversion optimization.",
    capabilities: ["WeChat Content", "Subscriber Growth", "Mini Programs", "Chinese Market"],
  },
  {
    ...base(),
    id: "xiaohongshu",
    name: "XIAOHONG",
    role: "Xiaohongshu Specialist",
    shortCode: "XH",
    avatar: nextAvatar(),
    color: "#FF1B6D",
    division: "Marketing",
    emoji: "🌸",
    description:
      "Expert Xiaohongshu marketing specialist focused on lifestyle content, trend-driven strategies, and authentic community engagement.",
    capabilities: ["RED Content", "Lifestyle Branding", "KOL Strategy", "Chinese Social"],
  },
  {
    ...base(),
    id: "zhihu-strat",
    name: "ZHIHU",
    role: "Zhihu Strategist",
    shortCode: "ZH",
    avatar: nextAvatar(),
    color: "#0084FF",
    division: "Marketing",
    emoji: "💡",
    description:
      "Expert Zhihu marketing specialist focused on thought leadership, community credibility, and knowledge-driven engagement.",
    capabilities: ["Q&A Strategy", "Thought Leadership", "Knowledge Content", "Brand Authority"],
  },

  // ─── PRODUCT ────────────────────────────────────────────────────────────────
  {
    ...base(),
    id: "behavioral-nudge",
    name: "NUDGE",
    role: "Behavioral Nudge Engine",
    shortCode: "BN",
    avatar: nextAvatar(),
    color: "#FF8A65",
    division: "Product",
    emoji: "🧠",
    description:
      "Behavioral psychology specialist that adapts software interaction cadences and styles to maximize user motivation and success.",
    capabilities: ["Behavioral Psychology", "UX Nudges", "Motivation Design", "Retention"],
  },
  {
    ...base(),
    id: "feedback-synth",
    name: "FEEDBACK",
    role: "Feedback Synthesizer",
    shortCode: "FS",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Product",
    emoji: "💭",
    description:
      "Expert in collecting, analyzing, and synthesizing user feedback to extract actionable product insights and strategic recommendations.",
    capabilities: ["Feedback Analysis", "User Insights", "Prioritization", "Voice of Customer"],
  },
  {
    ...base(),
    id: "sprint-prior",
    name: "SPRINT",
    role: "Sprint Prioritizer",
    shortCode: "SP",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Product",
    emoji: "⚡",
    description:
      "Expert product manager specializing in agile sprint planning, feature prioritization, and resource allocation for maximum velocity.",
    capabilities: ["Sprint Planning", "Feature Prioritization", "Agile", "Resource Allocation"],
  },
  {
    ...base(),
    id: "trend-research",
    name: "TRENDS",
    role: "Trend Researcher",
    shortCode: "TR",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Product",
    emoji: "🔭",
    description:
      "Expert market intelligence analyst specializing in identifying emerging trends, competitive analysis, and opportunity assessment.",
    capabilities: ["Trend Analysis", "Competitive Intel", "Market Research", "Opportunity Mapping"],
  },

  // ─── PROJECT MANAGEMENT ────────────────────────────────────────────────────
  {
    ...base(),
    id: "experiment-track",
    name: "EXPERIMENT",
    role: "Experiment Tracker",
    shortCode: "ET",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Project Management",
    emoji: "🧪",
    description:
      "Expert project manager specializing in experiment design, execution tracking, and data-driven decision making through systematic A/B testing.",
    capabilities: ["A/B Testing", "Hypothesis Validation", "Experiment Design", "Data Analysis"],
  },
  {
    ...base(),
    id: "project-shep",
    name: "SHEPHERD",
    role: "Project Shepherd",
    shortCode: "PS",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Project Management",
    emoji: "🗂️",
    description:
      "Expert project manager specializing in cross-functional project coordination, timeline management, and stakeholder alignment.",
    capabilities: [
      "Project Coordination",
      "Timeline Management",
      "Stakeholder Alignment",
      "Risk Management",
    ],
  },
  {
    ...base(),
    id: "studio-ops",
    name: "STUDIO OPS",
    role: "Studio Operations",
    shortCode: "SO",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Project Management",
    emoji: "🏢",
    description:
      "Expert operations manager specializing in day-to-day studio efficiency, process optimization, and resource coordination.",
    capabilities: [
      "Operations Management",
      "Process Optimization",
      "Resource Coordination",
      "Efficiency",
    ],
  },
  {
    ...base(),
    id: "studio-prod",
    name: "PRODUCER",
    role: "Studio Producer",
    shortCode: "STP",
    avatar: nextAvatar(),
    color: "#EAB308",
    division: "Project Management",
    emoji: "🎬",
    description:
      "Senior strategic leader specializing in high-level creative and technical project orchestration and multi-project portfolio management.",
    capabilities: [
      "Portfolio Management",
      "Creative Direction",
      "Strategic Planning",
      "Cross-team Leadership",
    ],
  },
  {
    ...base(),
    id: "senior-pm",
    name: "PM",
    role: "Senior Project Manager",
    shortCode: "PM",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Project Management",
    emoji: "📋",
    description:
      "Converts specs to tasks and remembers previous projects. Focused on realistic scope and exact spec requirements.",
    capabilities: ["Spec Analysis", "Task Breakdown", "Scope Management", "Delivery"],
  },

  // ─── TESTING ────────────────────────────────────────────────────────────────
  {
    ...base(),
    id: "accessibility-audit",
    name: "ALLY",
    role: "Accessibility Auditor",
    shortCode: "AA",
    avatar: nextAvatar(),
    color: "#0077B6",
    division: "Testing",
    emoji: "♿",
    description:
      "Expert accessibility specialist who audits interfaces against WCAG standards, tests with assistive technologies, and ensures inclusive design.",
    capabilities: ["WCAG 2.1", "Screen Reader Testing", "Accessibility Audits", "Inclusive Design"],
  },
  {
    ...base(),
    id: "api-tester",
    name: "API TEST",
    role: "API Tester",
    shortCode: "AT",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Testing",
    emoji: "🔌",
    description:
      "Expert API testing specialist focused on comprehensive API validation, performance testing, and quality assurance across all systems.",
    capabilities: ["API Validation", "Load Testing", "Integration Testing", "Contract Testing"],
  },
  {
    ...base(),
    id: "evidence-collect",
    name: "QA",
    role: "Evidence Collector",
    shortCode: "EC",
    avatar: nextAvatar(),
    color: "#F97316",
    division: "Testing",
    emoji: "📷",
    description:
      "Screenshot-obsessed, fantasy-allergic QA specialist. Requires visual proof for everything. Finds 3-5 issues per review.",
    capabilities: ["Visual QA", "Screenshot Testing", "Bug Documentation", "Regression Testing"],
  },
  {
    ...base(),
    id: "perf-benchmark",
    name: "PERF",
    role: "Performance Benchmarker",
    shortCode: "PB",
    avatar: nextAvatar(),
    color: "#F97316",
    division: "Testing",
    emoji: "⏱️",
    description:
      "Expert performance testing and optimization specialist focused on measuring and improving system performance across all applications.",
    capabilities: ["Load Testing", "Benchmarking", "Core Web Vitals", "Performance Profiling"],
  },
  {
    ...base(),
    id: "reality-check",
    name: "REALITY",
    role: "Reality Checker",
    shortCode: "RC",
    avatar: nextAvatar(),
    color: "#EF4444",
    division: "Testing",
    emoji: "🚨",
    description:
      'Stops fantasy approvals, evidence-based certification. Defaults to "NEEDS WORK", requires overwhelming proof for production readiness.',
    capabilities: [
      "Production Readiness",
      "Quality Gates",
      "Evidence Review",
      "Go/No-go Decisions",
    ],
  },
  {
    ...base(),
    id: "test-analyzer",
    name: "TEST ANL",
    role: "Test Results Analyzer",
    shortCode: "TA",
    avatar: nextAvatar(),
    color: "#6366F1",
    division: "Testing",
    emoji: "📊",
    description:
      "Expert test analysis specialist focused on comprehensive test result evaluation, quality metrics analysis, and actionable insight generation.",
    capabilities: ["Test Analysis", "Coverage Metrics", "Quality Reporting", "Trend Detection"],
  },
  {
    ...base(),
    id: "tool-evaluator",
    name: "TOOLS",
    role: "Tool Evaluator",
    shortCode: "TE",
    avatar: nextAvatar(),
    color: "#14B8A6",
    division: "Testing",
    emoji: "🔧",
    description:
      "Expert technology assessment specialist focused on evaluating, testing, and recommending tools, software, and platforms for business use.",
    capabilities: ["Tool Evaluation", "Technology Assessment", "Vendor Analysis", "ROI Analysis"],
  },
  {
    ...base(),
    id: "workflow-opt",
    name: "WORKFLOW",
    role: "Workflow Optimizer",
    shortCode: "WO",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Testing",
    emoji: "⚙️",
    description:
      "Expert process improvement specialist focused on analyzing, optimizing, and automating workflows across all business functions.",
    capabilities: [
      "Process Mapping",
      "Workflow Automation",
      "Bottleneck Analysis",
      "Efficiency Gains",
    ],
  },

  // ─── SUPPORT ─────────────────────────────────────────────────────────────────
  {
    ...base(),
    id: "analytics-rep",
    name: "ANALYTICS",
    role: "Analytics Reporter",
    shortCode: "AR",
    avatar: nextAvatar(),
    color: "#14B8A6",
    division: "Support",
    emoji: "📈",
    description:
      "Expert data analyst transforming raw data into actionable business insights. Creates dashboards, performs statistical analysis, and tracks KPIs.",
    capabilities: ["Dashboards", "KPI Tracking", "Statistical Analysis", "Data Visualization"],
  },
  {
    ...base(),
    id: "exec-summary",
    name: "EXEC",
    role: "Executive Summary Generator",
    shortCode: "ES",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Support",
    emoji: "📑",
    description:
      "Consultant-grade AI trained to think like a senior strategy consultant. Transforms complex inputs into concise, actionable executive summaries.",
    capabilities: ["Executive Comms", "Strategy Frameworks", "SCQA", "C-suite Reporting"],
  },
  {
    ...base(),
    id: "finance-track",
    name: "FINANCE",
    role: "Finance Tracker",
    shortCode: "FT",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Support",
    emoji: "💰",
    description:
      "Expert financial analyst specializing in financial planning, budget management, and business performance analysis.",
    capabilities: ["Budget Management", "Cash Flow", "Financial Planning", "P&L Analysis"],
  },
  {
    ...base(),
    id: "infra-maintain",
    name: "INFRA",
    role: "Infrastructure Maintainer",
    shortCode: "IM",
    avatar: nextAvatar(),
    color: "#F97316",
    division: "Support",
    emoji: "🖥️",
    description:
      "Expert infrastructure specialist focused on system reliability, performance optimization, and technical operations management.",
    capabilities: ["System Reliability", "Infrastructure Ops", "Monitoring", "Cost Optimization"],
  },
  {
    ...base(),
    id: "legal-compliance",
    name: "LEGAL",
    role: "Legal Compliance Checker",
    shortCode: "LC",
    avatar: nextAvatar(),
    color: "#EF4444",
    division: "Support",
    emoji: "⚖️",
    description:
      "Expert legal and compliance specialist ensuring business operations, data handling, and content comply with relevant laws and regulations.",
    capabilities: ["GDPR", "Compliance Audits", "Legal Review", "Risk Assessment"],
  },
  {
    ...base(),
    id: "support-respond",
    name: "SUPPORT",
    role: "Support Responder",
    shortCode: "SR",
    avatar: nextAvatar(),
    color: "#3B82F6",
    division: "Support",
    emoji: "🎧",
    description:
      "Expert customer support specialist delivering exceptional service, issue resolution, and user experience optimization across all channels.",
    capabilities: ["Customer Service", "Issue Resolution", "Multi-channel Support", "Satisfaction"],
  },

  // ─── SPATIAL COMPUTING ──────────────────────────────────────────────────────
  {
    ...base(),
    id: "macos-spatial",
    name: "METAL",
    role: "macOS Spatial/Metal Engineer",
    shortCode: "MS",
    avatar: nextAvatar(),
    color: "#60A5FA",
    division: "Spatial Computing",
    emoji: "🍎",
    description:
      "Native Swift and Metal specialist building high-performance 3D rendering systems and spatial computing experiences for macOS and Vision Pro.",
    capabilities: ["Metal API", "Swift", "SceneKit", "3D Rendering"],
  },
  {
    ...base(),
    id: "terminal-integ",
    name: "TERMINAL",
    role: "Terminal Integration Specialist",
    shortCode: "TI",
    avatar: nextAvatar(),
    color: "#22C55E",
    division: "Spatial Computing",
    emoji: "💻",
    description:
      "Terminal emulation, text rendering optimization, and SwiftTerm integration for modern Swift applications.",
    capabilities: ["Terminal Emulation", "SwiftTerm", "Text Rendering", "CLI Tools"],
  },
  {
    ...base(),
    id: "visionos-spatial",
    name: "VISION",
    role: "visionOS Spatial Engineer",
    shortCode: "VS",
    avatar: nextAvatar(),
    color: "#6366F1",
    division: "Spatial Computing",
    emoji: "👁️",
    description:
      "Native visionOS spatial computing, SwiftUI volumetric interfaces, and Liquid Glass design implementation for Apple Vision Pro.",
    capabilities: ["visionOS", "RealityKit", "Volumetric UI", "Spatial Audio"],
  },
  {
    ...base(),
    id: "xr-cockpit",
    name: "COCKPIT",
    role: "XR Cockpit Interaction Specialist",
    shortCode: "XC",
    avatar: nextAvatar(),
    color: "#F97316",
    division: "Spatial Computing",
    emoji: "🎮",
    description:
      "Specialist in designing and developing immersive cockpit-based control systems for XR environments.",
    capabilities: ["Cockpit Design", "XR Controls", "Haptic Feedback", "Immersive UI"],
  },
  {
    ...base(),
    id: "xr-immersive",
    name: "XR DEV",
    role: "XR Immersive Developer",
    shortCode: "XI",
    avatar: nextAvatar(),
    color: "#22D3EE",
    division: "Spatial Computing",
    emoji: "🥽",
    description:
      "Expert WebXR and immersive technology developer with specialization in browser-based AR/VR/XR applications.",
    capabilities: ["WebXR", "A-Frame", "Three.js XR", "Browser AR/VR"],
  },
  {
    ...base(),
    id: "xr-architect",
    name: "XR ARCH",
    role: "XR Interface Architect",
    shortCode: "XA",
    avatar: nextAvatar(),
    color: "#4ADE80",
    division: "Spatial Computing",
    emoji: "🌐",
    description:
      "Spatial interaction designer and interface strategist for immersive AR/VR/XR environments.",
    capabilities: ["Spatial Design", "XR Strategy", "Interaction Patterns", "Immersive UX"],
  },

  // ─── SPECIALIZED ────────────────────────────────────────────────────────────
  {
    ...base(),
    id: "agentic-identity",
    name: "IDENTITY",
    role: "Agentic Identity & Trust Architect",
    shortCode: "AIT",
    avatar: nextAvatar(),
    color: "#4ADE80",
    division: "Specialized",
    emoji: "🔑",
    description:
      "Designs identity, authentication, and trust verification systems for autonomous AI agents operating in multi-agent environments.",
    capabilities: ["Agent Auth", "Trust Verification", "Identity Systems", "Multi-agent Security"],
  },
  {
    ...base(),
    id: "agents-orchestrator",
    name: "ORCHESTRATOR",
    role: "Agents Orchestrator",
    shortCode: "AO",
    avatar: nextAvatar(),
    color: "#06B6D4",
    division: "Specialized",
    emoji: "🎯",
    description:
      "Autonomous pipeline manager that orchestrates the entire development workflow. Leader of multi-agent processes.",
    capabilities: [
      "Agent Orchestration",
      "Pipeline Management",
      "Multi-agent Coordination",
      "Workflow Execution",
    ],
  },
  {
    ...base(),
    id: "data-analytics",
    name: "DATA ANL",
    role: "Data Analytics Reporter",
    shortCode: "DA",
    avatar: nextAvatar(),
    color: "#6366F1",
    division: "Specialized",
    emoji: "📊",
    description:
      "Expert data analyst transforming raw data into actionable business insights with dashboards, statistical analysis, and strategic reporting.",
    capabilities: ["BI Dashboards", "Strategic Insights", "Data Modeling", "Executive Reporting"],
  },
  {
    ...base(),
    id: "data-consolidate",
    name: "CONSOLIDATOR",
    role: "Data Consolidation Agent",
    shortCode: "DC",
    avatar: nextAvatar(),
    color: "#38A169",
    division: "Specialized",
    emoji: "🗂️",
    description:
      "AI agent that consolidates extracted sales data into live reporting dashboards with territory, rep, and pipeline summaries.",
    capabilities: [
      "Data Consolidation",
      "Sales Dashboards",
      "Territory Reporting",
      "Pipeline Analytics",
    ],
  },
  {
    ...base(),
    id: "lsp-engineer",
    name: "LSP",
    role: "LSP/Index Engineer",
    shortCode: "LE",
    avatar: nextAvatar(),
    color: "#F97316",
    division: "Specialized",
    emoji: "🔍",
    description:
      "Language Server Protocol specialist building unified code intelligence systems through LSP client orchestration and semantic indexing.",
    capabilities: ["LSP", "Code Intelligence", "Semantic Indexing", "IDE Integration"],
  },
  {
    ...base(),
    id: "report-distribute",
    name: "DISTRIBUTOR",
    role: "Report Distribution Agent",
    shortCode: "RD",
    avatar: nextAvatar(),
    color: "#D69E2E",
    division: "Specialized",
    emoji: "📧",
    description:
      "AI agent that automates distribution of consolidated sales reports to representatives based on territorial parameters.",
    capabilities: [
      "Report Distribution",
      "Email Automation",
      "Territorial Targeting",
      "Scheduling",
    ],
  },
  {
    ...base(),
    id: "sales-extract",
    name: "SALES",
    role: "Sales Data Extraction Agent",
    shortCode: "SDE",
    avatar: nextAvatar(),
    color: "#2B6CB0",
    division: "Specialized",
    emoji: "💼",
    description:
      "AI agent specialized in monitoring Excel files and extracting key sales metrics (MTD, YTD, Year End) for internal live reporting.",
    capabilities: ["Excel Monitoring", "Sales Metrics", "MTD/YTD Extraction", "Live Reporting"],
  },
  {
    ...base(),
    id: "cultural-intel",
    name: "CULTURE",
    role: "Cultural Intelligence Strategist",
    shortCode: "CI",
    avatar: nextAvatar(),
    color: "#FFA000",
    division: "Specialized",
    emoji: "🌍",
    description:
      "CQ specialist that detects invisible exclusion, researches global context, and ensures software resonates authentically across intersectional identities.",
    capabilities: [
      "Cultural Intelligence",
      "Global Markets",
      "Inclusion Strategy",
      "Bias Detection",
    ],
  },
  {
    ...base(),
    id: "developer-advocate",
    name: "DEV ADV",
    role: "Developer Advocate",
    shortCode: "DVA",
    avatar: nextAvatar(),
    color: "#8B5CF6",
    division: "Specialized",
    emoji: "🤝",
    description:
      "Expert developer advocate specializing in building developer communities, creating compelling technical content, and optimizing developer experience.",
    capabilities: [
      "Developer Relations",
      "DX Optimization",
      "Technical Content",
      "Community Building",
    ],
  },
];

export const DIVISIONS: AgentDivision[] = [
  "Core",
  "Engineering",
  "Design",
  "Marketing",
  "Product",
  "Project Management",
  "Testing",
  "Support",
  "Spatial Computing",
  "Specialized",
];

export function getAgentsByDivision(division: AgentDivision): Agent[] {
  return AGENT_DEFINITIONS.filter((a) => a.division === division);
}

export function getAllDivisionCounts(): Record<AgentDivision, number> {
  const counts = {} as Record<AgentDivision, number>;
  for (const div of DIVISIONS) {
    counts[div] = getAgentsByDivision(div).length;
  }
  return counts;
}
