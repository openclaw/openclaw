/**
 * Unicode math rendering for terminal display.
 * Converts LaTeX math notation ($...$ and $$...$$) to Unicode equivalents.
 * @module tui-math
 */

/** Map of LaTeX commands to Unicode replacements */
const LATEX_TO_UNICODE: Record<string, string> = {
  // Operators
  "\\sum": "∑", "\\prod": "∏", "\\int": "∫", "\\oint": "∮",
  "\\infty": "∞", "\\pm": "±", "\\mp": "∓", "\\times": "×", "\\div": "÷",
  "\\cdot": "·", "\\star": "⋆", "\\circ": "∘", "\\bullet": "∙",
  "\\oplus": "⊕", "\\otimes": "⊗", "\\odot": "⊙",

  // Relations
  "\\leq": "≤", "\\geq": "≥", "\\neq": "≠", "\\approx": "≈",
  "\\equiv": "≡", "\\sim": "∼", "\\simeq": "≃", "\\cong": "≅",
  "\\propto": "∝", "\\ll": "≪", "\\gg": "≫", "\\prec": "≺", "\\succ": "≻",

  // Greek lowercase
  "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ",
  "\\epsilon": "ε", "\\varepsilon": "ε", "\\zeta": "ζ", "\\eta": "η",
  "\\theta": "θ", "\\vartheta": "ϑ", "\\iota": "ι", "\\kappa": "κ",
  "\\lambda": "λ", "\\mu": "μ", "\\nu": "ν", "\\xi": "ξ",
  "\\pi": "π", "\\varpi": "ϖ", "\\rho": "ρ", "\\varrho": "ϱ",
  "\\sigma": "σ", "\\varsigma": "ς", "\\tau": "τ", "\\upsilon": "υ",
  "\\phi": "φ", "\\varphi": "ϕ", "\\chi": "χ", "\\psi": "ψ", "\\omega": "ω",

  // Greek uppercase
  "\\Gamma": "Γ", "\\Delta": "Δ", "\\Theta": "Θ", "\\Lambda": "Λ",
  "\\Xi": "Ξ", "\\Pi": "Π", "\\Sigma": "Σ", "\\Upsilon": "Υ",
  "\\Phi": "Φ", "\\Psi": "Ψ", "\\Omega": "Ω",

  // Set theory
  "\\in": "∈", "\\notin": "∉", "\\ni": "∋",
  "\\subset": "⊂", "\\supset": "⊃", "\\subseteq": "⊆", "\\supseteq": "⊇",
  "\\cup": "∪", "\\cap": "∩", "\\emptyset": "∅", "\\varnothing": "∅",
  "\\setminus": "∖",

  // Logic
  "\\forall": "∀", "\\exists": "∃", "\\nexists": "∄",
  "\\neg": "¬", "\\lnot": "¬", "\\land": "∧", "\\lor": "∨",
  "\\vdash": "⊢", "\\models": "⊨", "\\top": "⊤", "\\bot": "⊥",

  // Calculus
  "\\nabla": "∇", "\\partial": "∂",

  // Arrows
  "\\to": "→", "\\rightarrow": "→", "\\leftarrow": "←",
  "\\Rightarrow": "⇒", "\\Leftarrow": "⇐",
  "\\leftrightarrow": "↔", "\\Leftrightarrow": "⇔",
  "\\mapsto": "↦", "\\uparrow": "↑", "\\downarrow": "↓",
  "\\nearrow": "↗", "\\searrow": "↘", "\\nwarrow": "↖", "\\swarrow": "↙",

  // Dots
  "\\ldots": "…", "\\cdots": "⋯", "\\vdots": "⋮", "\\ddots": "⋱",

  // Geometry & misc
  "\\perp": "⊥", "\\angle": "∠", "\\triangle": "△", "\\square": "□",
  "\\langle": "⟨", "\\rangle": "⟩", "\\lceil": "⌈", "\\rceil": "⌉",
  "\\lfloor": "⌊", "\\rfloor": "⌋",
  "\\ell": "ℓ", "\\hbar": "ℏ", "\\imath": "ı", "\\jmath": "ȷ",
  "\\Re": "ℜ", "\\Im": "ℑ", "\\wp": "℘", "\\aleph": "ℵ",

  // Spacing & formatting (strip these)
  "\\quad": " ", "\\qquad": "  ", "\\,": " ", "\\;": " ", "\\:": " ",
  "\\!": "", "\\left": "", "\\right": "", "\\big": "", "\\Big": "",
  "\\bigg": "", "\\Bigg": "", "\\displaystyle": "", "\\textstyle": "",
  "\\text": "",
};

/** Superscript digit map */
const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  "n": "ⁿ", "i": "ⁱ", "a": "ᵃ", "b": "ᵇ", "c": "ᶜ",
  "d": "ᵈ", "e": "ᵉ", "f": "ᶠ", "g": "ᵍ", "h": "ʰ",
  "k": "ᵏ", "l": "ˡ", "m": "ᵐ", "o": "ᵒ", "p": "ᵖ",
  "r": "ʳ", "s": "ˢ", "t": "ᵗ", "u": "ᵘ", "v": "ᵛ",
  "w": "ʷ", "x": "ˣ", "y": "ʸ", "z": "ᶻ",
};

/** Subscript digit map */
const SUBSCRIPTS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ",
  "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ",
  "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ",
  "v": "ᵥ", "x": "ₓ",
};

/** Blackboard bold map */
const BLACKBOARD: Record<string, string> = {
  "A": "𝔸", "B": "𝔹", "C": "ℂ", "D": "𝔻", "E": "𝔼",
  "F": "𝔽", "G": "𝔾", "H": "ℍ", "I": "𝕀", "J": "𝕁",
  "K": "𝕂", "L": "𝕃", "M": "𝕄", "N": "ℕ", "O": "𝕆",
  "P": "ℙ", "Q": "ℚ", "R": "ℝ", "S": "𝕊", "T": "𝕋",
  "U": "𝕌", "V": "𝕍", "W": "𝕎", "X": "𝕏", "Y": "𝕐", "Z": "ℤ",
};

/**
 * Convert a string of characters to superscript Unicode.
 */
function toSuperscript(s: string): string {
  return s.split("").map(c => SUPERSCRIPTS[c] ?? c).join("");
}

/**
 * Convert a string of characters to subscript Unicode.
 */
function toSubscript(s: string): string {
  return s.split("").map(c => SUBSCRIPTS[c] ?? c).join("");
}

/**
 * Convert a single LaTeX math expression (without delimiters) to Unicode.
 */
function latexToUnicode(latex: string): string {
  let result = latex.trim();

  // Handle \mathbb{X} → blackboard bold
  result = result.replace(/\\mathbb\{([A-Z])\}/g, (_, letter) => BLACKBOARD[letter] ?? letter);

  // Handle \frac{a}{b} → a⁄b
  result = result.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, (_, num, den) => {
    const n = latexToUnicode(num);
    const d = latexToUnicode(den);
    return `${n}⁄${d}`;
  });

  // Handle \sqrt{x} → √x and \sqrt[n]{x} → ⁿ√x
  result = result.replace(/\\sqrt\[([^\]]*)\]\{([^}]*)\}/g, (_, n, content) => {
    return `${toSuperscript(n)}√(${latexToUnicode(content)})`;
  });
  result = result.replace(/\\sqrt\{([^}]*)\}/g, (_, content) => `√(${latexToUnicode(content)})`);

  // Handle accents: \hat{x} → x̂, \bar{x} → x̄, etc.
  result = result.replace(/\\hat\{([^}])\}/g, "$1\u0302");
  result = result.replace(/\\bar\{([^}])\}/g, "$1\u0304");
  result = result.replace(/\\vec\{([^}])\}/g, "$1\u20D7");
  result = result.replace(/\\tilde\{([^}])\}/g, "$1\u0303");
  result = result.replace(/\\dot\{([^}])\}/g, "$1\u0307");
  result = result.replace(/\\ddot\{([^}])\}/g, "$1\u0308");

  // Handle superscripts: ^{...} and ^x (single char)
  result = result.replace(/\^\{([^}]*)\}/g, (_, content) => toSuperscript(content));
  result = result.replace(/\^([a-zA-Z0-9])/g, (_, c) => SUPERSCRIPTS[c] ?? `^${c}`);

  // Handle subscripts: _{...} and _x (single char)
  result = result.replace(/_\{([^}]*)\}/g, (_, content) => toSubscript(content));
  result = result.replace(/_([a-zA-Z0-9])/g, (_, c) => SUBSCRIPTS[c] ?? `_${c}`);

  // Handle \text{...} → just the text
  result = result.replace(/\\text\{([^}]*)\}/g, "$1");
  result = result.replace(/\\mathrm\{([^}]*)\}/g, "$1");
  result = result.replace(/\\mathit\{([^}]*)\}/g, "$1");
  result = result.replace(/\\mathbf\{([^}]*)\}/g, "$1");

  // Replace all known LaTeX commands (sort by length desc to match longest first)
  const sortedCommands = Object.keys(LATEX_TO_UNICODE).sort((a, b) => b.length - a.length);
  for (const cmd of sortedCommands) {
    // Escape backslashes for regex, use word boundary after command
    const escaped = cmd.replace(/\\/g, "\\\\");
    const pattern = new RegExp(escaped + "(?![a-zA-Z])", "g");
    result = result.replaceAll(pattern, LATEX_TO_UNICODE[cmd]);
  }

  // Strip remaining unrecognized \commands (but keep the content after)
  result = result.replace(/\\[a-zA-Z]+/g, "");

  // Clean up braces that were part of LaTeX grouping
  result = result.replace(/[{}]/g, "");

  // Clean up multiple spaces
  result = result.replace(/\s{2,}/g, " ").trim();

  return result;
}

/**
 * Find code block ranges to avoid processing LaTeX inside them.
 */
function getCodeBlockRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /```[\s\S]*?```|`[^`\n]+`/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/**
 * Check if a position falls inside a code block.
 */
function isInCodeBlock(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some(r => index >= r.start && index < r.end);
}

/**
 * Process LaTeX math expressions in text and convert to Unicode for terminal display.
 *
 * Supports:
 * - Display math: $$...$$ (rendered on its own line)
 * - Inline math: $...$ (rendered inline)
 * - Skips math inside code blocks
 *
 * @param text - Input text potentially containing LaTeX math
 * @returns Text with LaTeX converted to Unicode math symbols
 */
export function processLatexForTerminal(text: string): string {
  const codeRanges = getCodeBlockRanges(text);
  let result = text;

  // Process display math ($$...$$) first
  const displayPattern = /\$\$([^$]+)\$\$/g;
  const displayMatches: Array<{ full: string; latex: string; index: number }> = [];
  let match;

  while ((match = displayPattern.exec(text)) !== null) {
    if (!isInCodeBlock(match.index, codeRanges)) {
      displayMatches.push({ full: match[0], latex: match[1], index: match.index });
    }
  }

  // Replace from end to preserve indices
  for (let i = displayMatches.length - 1; i >= 0; i--) {
    const { full, latex, index } = displayMatches[i];
    const rendered = latexToUnicode(latex);
    const displayRendered = `\n  ${rendered}\n`;
    result = result.substring(0, index) + displayRendered + result.substring(index + full.length);
  }

  // Process inline math ($...$) — avoid matching $$
  const inlinePattern = /(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/g;
  const inlineMatches: Array<{ full: string; latex: string; index: number }> = [];

  // Re-compute code ranges after display math replacement
  const updatedCodeRanges = getCodeBlockRanges(result);

  while ((match = inlinePattern.exec(result)) !== null) {
    if (!isInCodeBlock(match.index, updatedCodeRanges)) {
      inlineMatches.push({ full: match[0], latex: match[1], index: match.index });
    }
  }

  for (let i = inlineMatches.length - 1; i >= 0; i--) {
    const { full, latex, index } = inlineMatches[i];
    const rendered = latexToUnicode(latex);
    result = result.substring(0, index) + rendered + result.substring(index + full.length);
  }

  return result;
}
