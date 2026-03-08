#!/bin/bash
# PR创建脚本
# 从当前功能分支创建PR

set -e

if [ -z "$1" ]; then
    echo "使用方法: $0 \"PR标题\" [\"PR描述\"]"
    echo "示例: $0 \"feat: add new model support\" \"## 添加新模型支持\\n\\n详细描述...\""
    exit 1
fi

PR_TITLE=$1
PR_DESCRIPTION=${2:-"## 变更说明\n\n请在此添加详细的PR描述。"}

echo "========================================="
echo "创建PR - $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "========================================="

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
PR_LOG="/root/.openclaw/workspace-github_expert/pr-create-$(date +%Y%m%d-%H%M%S).log"

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "错误：无法进入仓库目录 $REPO_DIR"
    exit 1
}

# 函数：记录日志
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" | tee -a "$PR_LOG"
}

# 1. 检查当前分支
log "步骤1: 检查当前分支..."
CURRENT_BRANCH=$(git branch --show-current)

if [[ ! "$CURRENT_BRANCH" =~ ^feature- ]]; then
    log "⚠️  当前分支 '$CURRENT_BRANCH' 不是功能分支"
    log "建议在 feature-* 分支上创建PR"
    read -p "是否继续? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 2. 确保分支是最新的
log "步骤2: 确保分支是最新的..."
git fetch origin
git merge origin/daily-sync --no-edit 2>/dev/null || {
    log "⚠️  有冲突需要解决"
    echo "请先解决冲突后再创建PR"
    exit 1
}

# 3. 推送分支到远程
log "步骤3: 推送分支到远程..."
git push origin "$CURRENT_BRANCH"

# 4. 检查修改
log "步骤4: 检查修改..."
CHANGES=$(git diff --name-only "origin/daily-sync"..."$CURRENT_BRANCH")
if [ -z "$CHANGES" ]; then
    log "❌ 没有检测到修改，请先进行修改"
    exit 1
fi

log "修改文件:"
echo "$CHANGES"

# 5. 生成PR描述（如果未提供详细描述）
if [ "$PR_DESCRIPTION" = "## 变更说明\n\n请在此添加详细的PR描述。" ]; then
    log "步骤5: 生成PR描述..."
    
    # 统计修改
    ADDITIONS=$(git diff --shortstat "origin/daily-sync"..."$CURRENT_BRANCH" | awk '{print $4}')
    DELETIONS=$(git diff --shortstat "origin/daily-sync"..."$CURRENT_BRANCH" | awk '{print $6}')
    
    # 获取提交信息
    COMMIT_MESSAGES=$(git log --oneline "origin/daily-sync"..."$CURRENT_BRANCH" | head -5)
    
    PR_DESCRIPTION="## 变更说明

### 修改统计
- **新增行数**: ${ADDITIONS:-0}
- **删除行数**: ${DELETIONS:-0}
- **修改文件**: $(echo "$CHANGES" | wc -l) 个

### 修改文件
\`\`\`
$CHANGES
\`\`\`

### 提交记录
\`\`\`
$COMMIT_MESSAGES
\`\`\`

### 测试说明
[请描述如何测试这些修改]

### 相关Issue
[链接到相关Issue，如果有]

### 检查清单
- [ ] 代码符合项目规范
- [ ] 已进行本地测试
- [ ] 文档已更新（如果需要）
- [ ] 没有引入新的警告或错误"
fi

# 6. 创建PR
log "步骤6: 创建PR..."
log "标题: $PR_TITLE"
log "分支: $CURRENT_BRANCH -> openclaw:main"

# 创建临时文件存储PR描述
TEMP_PR_FILE=$(mktemp)
echo "$PR_DESCRIPTION" > "$TEMP_PR_FILE"

# 尝试创建PR
PR_RESULT=$(gh pr create \
  --repo openclaw/openclaw \
  --base main \
  --head "jiangfeng2066:$CURRENT_BRANCH" \
  --title "$PR_TITLE" \
  --body-file "$TEMP_PR_FILE" 2>&1)

# 清理临时文件
rm -f "$TEMP_PR_FILE"

# 检查PR创建结果
if echo "$PR_RESULT" | grep -q "https://github.com/openclaw/openclaw/pull/"; then
    PR_URL=$(echo "$PR_RESULT" | grep -o "https://github.com/openclaw/openclaw/pull/[0-9]*")
    PR_NUMBER=$(echo "$PR_URL" | grep -o "[0-9]*$")
    
    log "🎉 PR创建成功!"
    log "PR号: #$PR_NUMBER"
    log "链接: $PR_URL"
    
    # 记录PR信息
    cat > "PR-${PR_NUMBER}-info.md" << EOF
# PR #$PR_NUMBER: $PR_TITLE

## 基本信息
- **PR号**: #$PR_NUMBER
- **标题**: $PR_TITLE
- **链接**: $PR_URL
- **分支**: $CURRENT_BRANCH -> main
- **创建时间**: $(date)
- **创建者**: GitHub Expert

## 修改内容
$(echo "$CHANGES" | sed 's/^/- /')

## 状态跟踪
- [ ] 等待CI检查
- [ ] 等待代码审查
- [ ] 审查通过
- [ ] 合并完成

## 相关文件
- 分支说明: BRANCH-${CURRENT_BRANCH}.md
- PR日志: $(basename "$PR_LOG")
EOF
    
    log "PR信息已保存到: PR-${PR_NUMBER}-info.md"
    
else
    log "❌ PR创建失败"
    log "错误信息:"
    echo "$PR_RESULT"
    
    # 提供备用方案
    log ""
    log "备用方案: 手动创建PR"
    log "1. 访问: https://github.com/openclaw/openclaw/compare/main...jiangfeng2066:${CURRENT_BRANCH}?expand=1"
    log "2. 使用标题: $PR_TITLE"
    log "3. 使用描述:"
    echo "$PR_DESCRIPTION"
fi

echo "========================================="
echo "PR创建流程完成"
echo "日志文件: $PR_LOG"
echo "========================================="

exit 0