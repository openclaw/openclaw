#!/bin/bash
# PR状态检查脚本
# 可以独立运行或由daily-sync.sh调用

set -e

echo "========================================="
echo "PR状态检查 - $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "========================================="

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
ACTIVE_PRS="34007"  # 当前活跃的PR列表，用空格分隔
STATUS_FILE="/root/.openclaw/workspace-github_expert/pr-status-$(date +%Y%m%d).json"

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "错误：无法进入仓库目录 $REPO_DIR"
    exit 1
}

# 函数：记录日志
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1"
}

# 函数：获取PR详细信息
get_pr_details() {
    local pr_number=$1
    local details
    
    details=$(gh pr view "$pr_number" --repo openclaw/openclaw --json \
        number,state,title,url,author,createdAt,isDraft,reviewDecision,mergeable,additions,deletions,labels 2>/dev/null || echo "{}")
    
    echo "$details"
}

# 函数：获取PR检查状态
get_pr_checks() {
    local pr_number=$1
    gh pr checks "$pr_number" --repo openclaw/openclaw 2>/dev/null || echo "检查失败"
}

# 初始化状态文件
echo "{" > "$STATUS_FILE"
echo "  \"timestamp\": \"$(date -Iseconds)\"," >> "$STATUS_FILE"
echo "  \"prs\": [" >> "$STATUS_FILE"

first_pr=true

# 检查每个PR
for PR in $ACTIVE_PRS; do
    log "检查 PR #$PR..."
    
    if [ "$first_pr" = false ]; then
        echo "    ," >> "$STATUS_FILE"
    fi
    first_pr=false
    
    # 获取PR详情
    PR_DETAILS=$(get_pr_details "$PR")
    
    if [ "$PR_DETAILS" = "{}" ]; then
        log "⚠️  无法获取PR #$PR 详情"
        echo "    {" >> "$STATUS_FILE"
        echo "      \"number\": $PR," >> "$STATUS_FILE"
        echo "      \"error\": \"无法获取PR详情\"" >> "$STATUS_FILE"
        echo "    }" >> "$STATUS_FILE"
        continue
    fi
    
    # 解析PR状态
    STATE=$(echo "$PR_DETAILS" | jq -r '.state // "UNKNOWN"')
    TITLE=$(echo "$PR_DETAILS" | jq -r '.title // "Unknown"')
    MERGEABLE=$(echo "$PR_DETAILS" | jq -r '.mergeable // "UNKNOWN"')
    REVIEW_DECISION=$(echo "$PR_DETAILS" | jq -r '.reviewDecision // ""')
    ADDITIONS=$(echo "$PR_DETAILS" | jq -r '.additions // 0')
    DELETIONS=$(echo "$PR_DETAILS" | jq -r '.deletions // 0')
    
    # 获取检查状态
    CHECKS=$(get_pr_checks "$PR")
    
    # 输出状态
    echo "PR #$PR: $TITLE"
    echo "  状态: $STATE"
    echo "  可合并: $MERGEABLE"
    echo "  审查决定: ${REVIEW_DECISION:-无}"
    echo "  修改: +${ADDITIONS} -${DELETIONS}"
    
    if [ "$MERGEABLE" = "CONFLICTING" ]; then
        log "❌ PR #$PR 有冲突需要解决"
    elif [ "$MERGEABLE" = "MERGEABLE" ]; then
        log "✅ PR #$PR 可合并"
    fi
    
    # 保存到状态文件
    echo "    {" >> "$STATUS_FILE"
    echo "      \"number\": $PR," >> "$STATUS_FILE"
    echo "      \"title\": $(echo "$PR_DETAILS" | jq '.title')," >> "$STATUS_FILE"
    echo "      \"state\": $(echo "$PR_DETAILS" | jq '.state')," >> "$STATUS_FILE"
    echo "      \"url\": $(echo "$PR_DETAILS" | jq '.url')," >> "$STATUS_FILE"
    echo "      \"mergeable\": $(echo "$PR_DETAILS" | jq '.mergeable')," >> "$STATUS_FILE"
    echo "      \"reviewDecision\": $(echo "$PR_DETAILS" | jq '.reviewDecision')," >> "$STATUS_FILE"
    echo "      \"additions\": $ADDITIONS," >> "$STATUS_FILE"
    echo "      \"deletions\": $DELETIONS," >> "$STATUS_FILE"
    echo "      \"checks\": \"$CHECKS\"" >> "$STATUS_FILE"
    echo "    }" >> "$STATUS_FILE"
done

# 完成状态文件
echo "  ]" >> "$STATUS_FILE"
echo "}" >> "$STATUS_FILE"

echo "========================================="
echo "PR状态检查完成"
echo "状态文件: $STATUS_FILE"
echo "========================================="

# 如果有冲突，发送通知
if echo "$ACTIVE_PRS" | grep -q "CONFLICTING"; then
    log "⚠️  检测到有冲突的PR，需要人工干预"
    # 这里可以添加通知逻辑
fi

exit 0