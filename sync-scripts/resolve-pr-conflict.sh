#!/bin/bash
# PR冲突解决脚本
# 当PR有冲突时自动或手动运行

set -e

if [ -z "$1" ]; then
    echo "使用方法: $0 <PR号>"
    echo "示例: $0 34007"
    exit 1
fi

PR_NUMBER=$1

echo "========================================="
echo "解决 PR #$PR_NUMBER 冲突 - $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "========================================="

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
LOG_FILE="/root/.openclaw/workspace-github_expert/conflict-resolve-$(date +%Y%m%d).log"

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "错误：无法进入仓库目录 $REPO_DIR"
    exit 1
}

# 函数：记录日志
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

# 1. 获取PR分支信息
log "步骤1: 获取PR分支信息..."
BRANCH_INFO=$(gh pr view "$PR_NUMBER" --repo openclaw/openclaw --json headRefName,baseRefName 2>/dev/null || echo "{}")

if [ "$BRANCH_INFO" = "{}" ]; then
    log "❌ 无法获取PR #$PR_NUMBER 信息"
    exit 1
fi

BRANCH_NAME=$(echo "$BRANCH_INFO" | jq -r '.headRefName')
BASE_REF=$(echo "$BRANCH_INFO" | jq -r '.baseRefName')

log "PR分支: $BRANCH_NAME -> $BASE_REF"

# 2. 检查分支是否存在
log "步骤2: 检查分支是否存在..."
if ! git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    log "分支 $BRANCH_NAME 不存在，从远程获取..."
    git fetch origin "$BRANCH_NAME:$BRANCH_NAME"
fi

# 3. 切换到PR分支
log "步骤3: 切换到PR分支..."
git checkout "$BRANCH_NAME"
git status

# 4. 获取上游最新代码
log "步骤4: 获取上游最新代码..."
git fetch upstream

# 5. 合并上游代码（尝试自动解决冲突）
log "步骤5: 合并上游代码..."
if git merge "upstream/$BASE_REF" --no-commit; then
    log "✅ 自动合并成功，无冲突"
else
    log "⚠️  检测到冲突，需要解决"
    
    # 显示冲突文件
    CONFLICT_FILES=$(git diff --name-only --diff-filter=U)
    log "冲突文件:"
    echo "$CONFLICT_FILES"
    
    # 对于特定类型的文件，尝试自动解决
    for file in $CONFLICT_FILES; do
        case "$file" in
            *.env.example)
                log "尝试自动解决 $file 冲突..."
                # 对于.env.example，保留我们的修改
                git checkout --ours "$file"
                ;;
            docs/*.md)
                log "尝试自动解决 $file 冲突..."
                # 对于文档文件，尝试合并
                git checkout --ours "$file"
                ;;
            *)
                log "需要手动解决 $file 冲突"
                ;;
        esac
    done
    
    # 检查是否还有冲突
    if git diff --check; then
        log "✅ 所有冲突已解决"
    else
        log "❌ 仍有未解决的冲突，需要人工干预"
        echo "请手动解决以下文件的冲突:"
        git diff --name-only --diff-filter=U
        exit 1
    fi
fi

# 6. 提交合并
log "步骤6: 提交合并..."
git add .
git commit -m "fix: resolve merge conflicts with upstream

- 合并上游最新代码
- 解决文件冲突
- 更新PR分支"

# 7. 推送到远程
log "步骤7: 推送到远程..."
git push origin "$BRANCH_NAME" --force-with-lease

# 8. 验证PR状态
log "步骤8: 验证PR状态..."
sleep 5  # 等待GitHub更新
NEW_STATE=$(gh pr view "$PR_NUMBER" --repo openclaw/openclaw --json mergeable -q '.mergeable' 2>/dev/null || echo "UNKNOWN")

if [ "$NEW_STATE" = "MERGEABLE" ]; then
    log "🎉 PR #$PR_NUMBER 冲突已解决，现在可合并"
else
    log "⚠️  PR #$PR_NUMBER 状态: $NEW_STATE"
fi

echo "========================================="
echo "冲突解决完成"
echo "日志文件: $LOG_FILE"
echo "PR链接: https://github.com/openclaw/openclaw/pull/$PR_NUMBER"
echo "========================================="

exit 0