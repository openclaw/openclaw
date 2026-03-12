/**
 * Repo Map & Symbol Index - Phase 2
 *
 * For code operations:
 * - File tree map
 * - Symbol index (classes, functions, methods, imports)
 * - Dependency graph
 * - Patch planner
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============== FILE TREE MAP ==============

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  language?: string;
}

export interface RepoMap {
  root: string;
  fileCount: number;
  directoryCount: number;
  languages: Map<string, number>;
  files: FileNode[];
  importantFiles: string[];
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.java': 'Java',
  '.go': 'Go',
  '.rs': 'Rust',
  '.cpp': 'C++',
  '.c': 'C',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.md': 'Markdown',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.ps1': 'PowerShell',
};

const IMPORTANT_FILES = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'requirements.txt',
  'Pipfile',
  'pom.xml',
  'build.gradle',
  'tsconfig.json',
  '.gitignore',
  'README.md',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
];

export class RepoMapBuilder {
  private rootPath: string;
  private maxDepth: number;
  private excludePatterns: string[];

  constructor(rootPath: string, maxDepth: number = 5) {
    this.rootPath = rootPath;
    this.maxDepth = maxDepth;
    this.excludePatterns = [
      'node_modules',
      '.git',
      'dist',
      'build',
      'target',
      '__pycache__',
      '.venv',
      'venv',
      'coverage',
      '.next',
      '.nuxt',
    ];
  }

  /**
   * Build the complete repo map
   */
  build(): RepoMap {
    const files: FileNode[] = [];
    const languages = new Map<string, number>();
    let fileCount = 0;
    let directoryCount = 0;
    const importantFiles: string[] = [];

    this.scanDirectory(this.rootPath, files, 0, languages, importantFiles);

    return {
      root: this.rootPath,
      fileCount,
      directoryCount,
      languages,
      files,
      importantFiles,
    };
  }

  /**
   * Recursively scan directory
   */
  private scanDirectory(
    dirPath: string,
    files: FileNode[],
    depth: number,
    languages: Map<string, number>,
    importantFiles: string[]
  ): void {
    if (depth > this.maxDepth) return;

    try {
      const items = fs.readdirSync(dirPath);

      for (const item of items) {
        // Skip excluded patterns
        if (this.excludePatterns.some((p) => item === p || item.startsWith(p))) {
          continue;
        }

        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          directoryCount++;
          const dirNode: FileNode = {
            name: item,
            path: fullPath,
            type: 'directory',
            children: [],
          };
          files.push(dirNode);
          this.scanDirectory(fullPath, dirNode.children!, depth + 1, languages, importantFiles);
        } else {
          fileCount++;
          const ext = path.extname(item).toLowerCase();
          const language = LANGUAGE_EXTENSIONS[ext] || 'Other';

          languages.set(language, (languages.get(language) || 0) + 1);

          // Check if important
          if (IMPORTANT_FILES.includes(item)) {
            importantFiles.push(fullPath);
          }

          files.push({
            name: item,
            path: fullPath,
            type: 'file',
            language,
          });
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }

  /**
   * Get summary as string
   */
  getSummary(repoMap: RepoMap): string {
    const parts: string[] = [
      `Root: ${repoMap.root}`,
      `Files: ${repoMap.fileCount}`,
      `Directories: ${repoMap.directoryCount}`,
      `Languages:`,
    ];

    for (const [lang, count] of repoMap.languages) {
      parts.push(`  - ${lang}: ${count}`);
    }

    if (repoMap.importantFiles.length > 0) {
      parts.push(`Important files: ${repoMap.importantFiles.length}`);
    }

    return parts.join('\n');
  }
}

// ============== SYMBOL INDEX ==============

export interface Symbol {
  name: string;
  type: 'class' | 'function' | 'method' | 'import' | 'variable' | 'interface' | 'type';
  line: number;
  column: number;
  file: string;
  visibility?: 'public' | 'private' | 'protected';
}

export interface SymbolIndex {
  root: string;
  symbols: Symbol[];
  byFile: Map<string, Symbol[]>;
  byType: Map<string, Symbol[]>;
}

export class SymbolIndexer {
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  /**
   * Index all symbols in the repository
   */
  async index(): Promise<SymbolIndex> {
    const symbols: Symbol[] = [];
    const byFile = new Map<string, Symbol[]>();
    const byType = new Map<string, Symbol[]>();

    await this.indexDirectory(this.rootPath, symbols, byFile);

    // Group by type
    for (const symbol of symbols) {
      const typeSymbols = byType.get(symbol.type) || [];
      typeSymbols.push(symbol);
      byType.set(symbol.type, typeSymbols);
    }

    return {
      root: this.rootPath,
      symbols,
      byFile,
      byType,
    };
  }

  /**
   * Index a directory recursively
   */
  private async indexDirectory(
    dirPath: string,
    symbols: Symbol[],
    byFile: Map<string, Symbol[]>
  ): Promise<void> {
    const exclude = ['node_modules', '.git', 'dist', 'build', '__pycache__'];

    try {
      const items = fs.readdirSync(dirPath);

      for (const item of items) {
        if (exclude.includes(item)) continue;

        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          await this.indexDirectory(fullPath, symbols, byFile);
        } else {
          const ext = path.extname(item).toLowerCase();
          const fileSymbols = await this.indexFile(fullPath, ext);
          symbols.push(...fileSymbols);
          byFile.set(fullPath, fileSymbols);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string, ext: string): Promise<Symbol[]> {
    const symbols: Symbol[] = [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
        this.indexTypeScript(content, filePath, lines, symbols);
      } else if (ext === '.py') {
        this.indexPython(content, filePath, lines, symbols);
      }
    } catch {
      // Skip files we can't read
    }

    return symbols;
  }

  /**
   * Index TypeScript/JavaScript file
   */
  private indexTypeScript(
    content: string,
    filePath: string,
    lines: string[],
    symbols: Symbol[]
  ): void {
    // Class declarations
    const classRegex = /(?:export\s+)?class\s+(\w+)/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({
        name: match[1],
        type: 'class',
        line,
        column: match.index,
        file: filePath,
        visibility: content.includes(`export class ${match[1]}`) ? 'public' : 'private',
      });
    }

    // Function declarations
    const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
    while ((match = funcRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({
        name: match[1],
        type: 'function',
        line,
        column: match.index,
        file: filePath,
      });
    }

    // Arrow functions assigned to const
    const arrowRegex = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/g;
    while ((match = arrowRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({
        name: match[1],
        type: 'function',
        line,
        column: match.index,
        file: filePath,
      });
    }

    // Interface/Type declarations
    const interfaceRegex = /(?:export\s+)?(?:interface|type)\s+(\w+)/g;
    while ((match = interfaceRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({
        name: match[1],
        type: 'interface',
        line,
        column: match.index,
        file: filePath,
      });
    }

    // Import statements
    const importRegex = /import\s+(?:{[^}]+}|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = importRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({
        name: match[2],
        type: 'import',
        line,
        column: match.index,
        file: filePath,
      });
    }
  }

  /**
   * Index Python file
   */
  private indexPython(
    content: string,
    filePath: string,
    lines: string[],
    symbols: Symbol[]
  ): void {
    // Class declarations
    const classRegex = /class\s+(\w+)(?:\([^)]*\))?:/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({
        name: match[1],
        type: 'class',
        line,
        column: match.index,
        file: filePath,
      });
    }

    // Function definitions
    const funcRegex = /(?:async\s+)?def\s+(\w+)\s*\(/g;
    while ((match = funcRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({
        name: match[1],
        type: 'function',
        line,
        column: match.index,
        file: filePath,
      });
    }
  }

  /**
   * Search symbols by name
   */
  search(index: SymbolIndex, query: string): Symbol[] {
    const queryLower = query.toLowerCase();
    return index.symbols.filter(
      (s) => s.name.toLowerCase().includes(queryLower)
    );
  }
}

// ============== PATCH PLANNER ==============

export interface Patch {
  file: string;
  originalLines: string[];
  newLines: string[];
  lineStart: number;
  lineEnd: number;
}

export interface PatchResult {
  success: boolean;
  patches: Patch[];
  errors: string[];
}

export class PatchPlanner {
  /**
   * Apply patches to files
   */
  async apply(patches: Patch[]): Promise<PatchResult> {
    const errors: string[] = [];

    for (const patch of patches) {
      try {
        if (!fs.existsSync(patch.file)) {
          errors.push(`File not found: ${patch.file}`);
          continue;
        }

        const content = fs.readFileSync(patch.file, 'utf-8');
        const lines = content.split('\n');

        // Replace lines
        const newLines = [
          ...lines.slice(0, patch.lineStart - 1),
          ...patch.newLines,
          ...lines.slice(patch.lineEnd),
        ];

        fs.writeFileSync(patch.file, newLines.join('\n'), 'utf-8');
      } catch (error) {
        errors.push(`Error applying patch to ${patch.file}: ${error}`);
      }
    }

    return {
      success: errors.length === 0,
      patches,
      errors,
    };
  }

  /**
   * Create a patch for line replacement
   */
  createLinePatch(
    file: string,
    lineStart: number,
    lineEnd: number,
    newLines: string[]
  ): Patch {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    return {
      file,
      originalLines: lines.slice(lineStart - 1, lineEnd),
      newLines,
      lineStart,
      lineEnd,
    };
  }
}

// ============== EXPORTS ==============

export const repoMapBuilder = (rootPath: string) => new RepoMapBuilder(rootPath);
export const symbolIndexer = (rootPath: string) => new SymbolIndexer(rootPath);
export const patchPlanner = new PatchPlanner();

export default {
  RepoMapBuilder,
  SymbolIndexer,
  PatchPlanner,
};
