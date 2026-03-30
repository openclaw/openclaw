/**
 * Context Tools - 上下文压缩工具
 *
 * 为 LLM 提供主动压缩上下文的工具
 */

import { ContextArchive, createContextArchive } from '../context-engine/archive';
import type { Tool } from './common';

// 存档管理器实例缓存
const archiveInstances = new Map<string, ContextArchive>();

/**
 * 获取或创建存档管理器
 */
function getArchive(sessionId: string): ContextArchive {
  if (!archiveInstances.has(sessionId)) {
    archiveInstances.set(sessionId, createContextArchive(sessionId));
  }
  return archiveInstances.get(sessionId)!;
}

/**
 * compress_context 工具定义
 *
 * 允许 LLM 主动压缩上下文并存档
 */
export const compressContextTool: Tool = {
  name: 'compress_context',
  description: `Compress and archive a range of messages from the current context.

Use this tool when:
- The topic has clearly shifted (e.g., from coding to writing)
- User explicitly wants to start a new task
- Context is approaching token limits

This tool will:
1. Archive the specified message range with a summary
2. Save to ~/.openclaw/archives/ directory
3. Return the archive path and tokens saved

You should provide a meaningful summary that captures:
- Main discussion points
- Key decisions made
- Important context for future reference`,

  input_schema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'A brief title for the archived topic, e.g., "React component optimization discussion"',
      },
      summary: {
        type: 'string',
        description: 'Structured summary in Markdown format. Include main points, context, and outcomes.',
      },
      key_decisions: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of key decisions or conclusions from this discussion',
      },
      message_range: {
        type: 'object',
        properties: {
          start: {
            type: 'integer',
            description: 'Start index of messages to archive (0-based)',
          },
          end: {
            type: 'integer',
            description: 'End index of messages to archive (inclusive)',
          },
        },
        required: ['start', 'end'],
      },
      importance: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        default: 'medium',
        description: 'Importance level. High importance archives are kept longer.',
      },
    },
    required: ['topic', 'summary', 'message_range'],
  },

  handler: async (params: {
    topic: string;
    summary: string;
    key_decisions?: string[];
    message_range: { start: number; end: number };
    importance?: 'high' | 'medium' | 'low';
  }, context: { sessionId: string }) => {
    const archive = getArchive(context.sessionId);

    const result = await archive.archive({
      topic: params.topic,
      summary: params.summary,
      key_decisions: params.key_decisions,
      message_range: params.message_range,
      importance: params.importance,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Successfully archived context.

**Archive ID**: ${result.archive_id}
**Archive Path**: ${result.archive_path}
**Tokens Saved**: ~${result.tokens_saved}

${result.message}

The archived content can be recalled later using the \`recall_archive\` tool.`,
        },
      ],
    };
  },
};

/**
 * list_archives 工具定义
 *
 * 列出历史存档
 */
export const listArchivesTool: Tool = {
  name: 'list_archives',
  description: `List archived contexts from previous compressions.

Use this tool to find and recall archived conversations.

You can filter by:
- Date (YYYY-MM-DD format)
- Topic keyword

Returns a list of archives with their paths, topics, and token counts.`,

  input_schema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'Filter by date (YYYY-MM-DD format)',
      },
      topic_keyword: {
        type: 'string',
        description: 'Filter by topic keyword',
      },
      limit: {
        type: 'integer',
        default: 10,
        description: 'Maximum number of results to return',
      },
    },
  },

  handler: async (params: {
    date?: string;
    topic_keyword?: string;
    limit?: number;
  }, context: { sessionId: string }) => {
    const archive = getArchive(context.sessionId);
    const result = await archive.list({
      date: params.date,
      topic_keyword: params.topic_keyword,
      limit: params.limit,
    });

    if (result.archives.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No archives found matching the criteria.',
          },
        ],
      };
    }

    const archiveList = result.archives
      .map((a, i) => `${i + 1}. **${a.topic}**\n   - ID: \`${a.id}\`\n   - Path: \`${a.path}\`\n   - Date: ${a.created_at.slice(0, 10)}\n   - Tokens: ${a.tokens_saved}`)
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${result.total_count} archive(s):

${archiveList}

Use \`recall_archive\` with the archive path to restore content.`,
        },
      ],
    };
  },
};

/**
 * recall_archive 工具定义
 *
 * 恢复存档内容
 */
export const recallArchiveTool: Tool = {
  name: 'recall_archive',
  description: `Recall and restore content from an archived context.

Modes:
- \`summary\`: Return just the summary (recommended)
- \`key_points\`: Return only key decisions
- \`full\`: Return complete archived content

Use this when you need to reference previous discussions that were archived.`,

  input_schema: {
    type: 'object',
    properties: {
      archive_path: {
        type: 'string',
        description: 'Path to the archive file (from list_archives)',
      },
      mode: {
        type: 'string',
        enum: ['summary', 'full', 'key_points'],
        default: 'summary',
        description: 'How much content to restore',
      },
    },
    required: ['archive_path'],
  },

  handler: async (params: {
    archive_path: string;
    mode?: 'summary' | 'full' | 'key_points';
  }, context: { sessionId: string }) => {
    const archive = getArchive(context.sessionId);

    try {
      const result = await archive.recall(params.archive_path, params.mode);

      return {
        content: [
          {
            type: 'text',
            text: `**Restored Archive Content** (~${result.tokens_added} tokens)

---

${result.content}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Unable to recall archive. ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  },
};

// 导出所有工具
export const contextTools = [
  compressContextTool,
  listArchivesTool,
  recallArchiveTool,
];

export default contextTools;