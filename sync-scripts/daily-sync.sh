#!/bin/bash
# 每日同步脚本 - 基于分支的同步工作流
# 执行时间：每天 03:00 UTC

set -e

echo "========================================="
echo "开始每日同步 - $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "========================================="

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
LOG_FILE="/root/.openclaw/workspace-github_expert/sync-log-$(date +%Y%m%d).log"
ACTIVE_PR="34007"  # 当前活跃的PR

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "错误：无法进入仓库目录 $REPO_DIR"
    exit 1
}

# 记录开始时间
START_TIME=$(date +%s)

# 函数：记录日志
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

# 函数：检查命令执行结果
check_result() {
    if [ $? -eq 0 ]; then
        log "✅ $1"
    else
        log "❌ $1 失败"
        exit 1
    fi
}

# 1. 确保上游远程存在
log "步骤1: 检查上游远程配置..."
git remote | grep -q upstream || {
    git remote add upstream https://github.com/openclaw/openclaw.git
    log "添加上游远程: upstream"
}
check_result "上游远程配置检查"

# 2. 获取上游最新代码
log "步骤2: 获取上游最新代码..."
git fetch upstream
check_result "获取上游代码"

# 3. 更新main分支（与上游保持同步）
log "步骤3: 更新main分支..."
git checkout main
git merge upstream/main --ff-only --no-edit
check_result "更新main分支"

# 4. 更新daily-sync分支
log "步骤4: 更新daily-sync分支..."
git checkout daily-sync 2>/dev/null || {
    log "daily-sync分支不存在，从main创建..."
    git checkout -b daily-sync
}
git merge main --no-ff --no-edit -m "chore: daily sync $(date +%Y-%m-%d)"
check_result "更新daily-sync分支"

# 5. 推送更新到fork
log "步骤5: 推送更新到fork..."
git push origin main
git push origin daily-sync
check_result "推送更新到fork"

# 6. 检查活跃PR状态
log "步骤6: 检查活跃PR状态..."
if [ -n "$ACTIVE_PR" ]; then
    log "检查 PR #$ACTIVE_PR 状态..."
    
    # 获取PR状态
    PR_STATE=$(gh pr view "$ACTIVE_PR" --repo openclaw/openclaw --json state -q '.state' 2>/dev/null || echo "ERROR")
    PR_MERGEABLE=$(gh pr view "$ACTIVE_PR" --repo openclaw/openclaw --json mergeable -q '.mergeable' 2>/dev/null || echo "ERROR")
    
    if [ "$PR_STATE" = "ERROR" ] || [ "$PR_MERGEABLE" = "ERROR" ]; then
        log "⚠️  无法获取PR #$ACTIVE_PR 状态"
    else
        log "PR #$ACTIVE_PR 状态: $PR_STATE, 可合并: $PR_MERGEABLE"
        
        # 检查是否需要更新PR分支
        if [ "$PR_MERGEABLE" = "CONFLICTING" ]; then
            log "⚠️  PR #$ACTIVE_PR 有冲突，需要解决"
            # 这里可以触发冲突解决脚本
        fi
    fi
else
    log "没有活跃PR需要检查"
fi

# 7. 生成状态报告
log "步骤7: 生成状态报告..."
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "========================================="
echo "每日同步完成摘要"
echo "========================================="
echo "开始时间: $(date -d @$START_TIME '+%Y-%m-%d %H:%M:%S')"
echo "结束时间: $(date -d @$END_TIME '+%Y-%m-%d %H:%M:%S')"
echo "耗时: ${DURATION}秒"
echo ""
echo "分支状态:"
echo "  main:       ✅ 与上游同步"
echo "  daily-sync: ✅ 基于main更新"
echo ""
if [ -n "$ACTIVE_PR" ]; then
    echo "活跃PR状态:"
    echo "  PR #$ACTIVE_PR: $PR_STATE ($PR_MERGEABLE)"
fi
echo ""
echo "日志文件: $LOG_FILE"
echo "========================================="

# 记录完成时间
log "每日同步完成，耗时 ${DURATION}秒"

exit 0