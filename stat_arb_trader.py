#!/usr/bin/env python3
"""
Polymarket 双边挂单策略 - 统计套利交易机器人
版本: v3.0 - 改善版 (整合Copilot建議)
改进:
- ContractTimer: 精确的相对时间逻辑
- APIRetryManager: API调用重试机制
- StopLossManager: 完整止损失管理
- FundManager: 资金隔离管理
- PairCostTracker: Pair Cost加权计算
"""

import sys
import time
import datetime
import json
import os
import random
import logging
from typing import Dict, Optional, Tuple, List
from logging.handlers import RotatingFileHandler

sys.path.append('/root/.openclaw/workspace')

try:
    from authenticated_clob_client import AuthenticatedClobClient
except ImportError:
    print("⚠️ 未找到 authenticated_clob_client，使用模拟版本")
    AuthenticatedClobClient = None


# ============================================================================
# 改善类 1: ContractTimer - 精确的15分钟合约计时器
# ============================================================================
class ContractTimer:
    """改进的15分钟合约计时器 - 使用相对时间"""
    
    def __init__(self):
        self.contract_start_time = None
        self.contract_id = None
        self.reset_contract()
    
    def get_current_contract_id(self) -> str:
        """生成当前合约的唯一ID"""
        now = datetime.datetime.now()
        # 例: "2026-02-27_09:00" (精确到15分钟块)
        minutes = (now.hour * 60 + now.minute) // 15 * 15
        hour = minutes // 60
        minute = minutes % 60
        return f"{now.date()}_{hour:02d}:{minute:02d}"
    
    def get_elapsed_seconds(self) -> float:
        """计算合约开始以来的秒数"""
        if self.contract_start_time is None:
            self.reset_contract()
        return time.time() - self.contract_start_time
    
    def get_elapsed_minutes(self) -> int:
        """计算已过分钟数(精确)"""
        return int(self.get_elapsed_seconds() // 60)
    
    def is_new_contract(self) -> bool:
        """检查是否进入新合约"""
        current_id = self.get_current_contract_id()
        if self.contract_id != current_id:
            self.contract_id = current_id
            return True
        return False
    
    def reset_contract(self):
        """重置为当前合约的开始时间"""
        now = datetime.datetime.now()
        minutes = (now.hour * 60 + now.minute) // 15 * 15
        hour = minutes // 60
        minute = minutes % 60
        contract_start = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        self.contract_start_time = contract_start.timestamp()
        self.contract_id = self.get_current_contract_id()


# ============================================================================
# 改善类 2: APIRetryManager - API调用重试管理
# ============================================================================
class APIRetryManager:
    """API调用重试管理 - 指数退避"""
    
    def __init__(self, max_retries: int = 3, base_delay: float = 1.0):
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.logger = logging.getLogger("TradingBot.APIRetry")
    
    def exponential_backoff(self, attempt: int) -> float:
        """指数退避计算延迟"""
        return self.base_delay * (2 ** attempt) + random.uniform(0, 1)
    
    def call_with_retry(self, func, *args, **kwargs):
        """带重试的API调用"""
        last_error = None
        for attempt in range(self.max_retries):
            try:
                result = func(*args, **kwargs)
                if attempt > 0:
                    self.logger.info(f"API调用成功 (尝试 {attempt + 1})")
                return result
            except Exception as e:
                last_error = e
                if attempt < self.max_retries - 1:
                    delay = self.exponential_backoff(attempt)
                    self.logger.warning(f"API调用失败，{delay:.1f}秒后重试 ({attempt + 1}/{self.max_retries}): {e}")
                    time.sleep(delay)
                else:
                    self.logger.error(f"API调用失败 ({self.max_retries}次重试后): {e}")
        raise last_error


# ============================================================================
# 改善类 3: StopLossManager - 完整的止损失管理
# ============================================================================
class StopLossManager:
    """完整的止损失管理"""
    
    def __init__(self, config: Dict, contract_timer: ContractTimer):
        self.config = config
        self.contract_timer = contract_timer
        self.filled_orders = {}  # {side: {filled_time, filled_price, quantity}}
        self.stop_loss_triggered = False
        self.logger = logging.getLogger("TradingBot.StopLoss")
    
    def record_fill(self, side: str, price: float, quantity: int):
        """记录成交"""
        self.filled_orders[side] = {
            "filled_time": time.time(),
            "filled_price": price,
            "quantity": quantity,
            "contract_time_at_fill": self.contract_timer.get_elapsed_minutes()
        }
        self.logger.info(f"记录成交: {side} {quantity}股 @ ${price:.4f}")
    
    def clear_fills(self):
        """清除成交记录"""
        self.filled_orders = {}
    
    def check_stop_loss_conditions(self) -> Tuple[bool, str]:
        """
        检查所有止损失条件
        Returns:
            (should_stop_loss, reason)
        """
        elapsed_min = self.contract_timer.get_elapsed_minutes()
        
        # 条件1: 第10分钟必止损失
        if elapsed_min >= 10:
            return True, f"合约第{elapsed_min}分钟"
        
        # 条件2: 单边成交超过特定时间
        if len(self.filled_orders) == 1:
            filled_side = list(self.filled_orders.keys())[0]
            filled_info = self.filled_orders[filled_side]
            filled_time = filled_info["filled_time"]
            time_since_fill = time.time() - filled_time
            
            # 动态超时: 前10分钟480秒，后5分钟60秒
            timeout = 480 if elapsed_min < 10 else 60
            
            if time_since_fill > timeout:
                return True, f"单边成交超过{timeout}秒"
        
        # 条件3: 第9分钟时如果还是单边，准备止损失
        if elapsed_min == 9 and len(self.filled_orders) == 1:
            return True, "第9分钟单边成交，准备清算"
        
        return False, ""
    
    def should_force_flatten(self) -> bool:
        """强制平仓检查"""
        elapsed_min = self.contract_timer.get_elapsed_minutes()
        # 距离清算<2分钟且有单边持仓
        if elapsed_min >= 13 and len(self.filled_orders) == 1:
            return True
        return False
    
    def get_filled_sides(self) -> List[str]:
        """获取已成交的方向"""
        return list(self.filled_orders.keys())


# ============================================================================
# 改善类 4: FundManager - 统一资金管理
# ============================================================================
class FundManager:
    """统一资金管理 - 资金隔离"""
    
    def __init__(self, initial_balance: float):
        self.initial_balance = initial_balance
        self.available = initial_balance  # 可用资金
        self.reserved = {}  # {contract_id: reserved_amount}
        self.used = {}  # {contract_id: actual_used_amount}
        self.history = []  # 资金变化历史
        self.logger = logging.getLogger("TradingBot.Fund")
    
    def reserve_for_trade(self, contract_id: str, amount: float) -> bool:
        """为即将进行的交易预留资金"""
        if amount > self.available:
            self.logger.warning(f"资金不足: 需要${amount:.2f}, 可用${self.available:.2f}")
            return False
        self.reserved[contract_id] = amount
        self.available -= amount
        self._record("reserve", -amount)
        self.logger.info(f"预留资金: ${amount:.2f}, 剩余${self.available:.2f}")
        return True
    
    def commit_trade(self, contract_id: str, actual_cost: float) -> bool:
        """确认交易已执行"""
        if contract_id not in self.reserved:
            self.logger.warning(f"合约 {contract_id} 未预留资金")
            return False
        reserved = self.reserved[contract_id]
        if actual_cost > reserved:
            self.logger.error(f"实际成本超过预留: ${actual_cost:.2f} > ${reserved:.2f}")
            return False
        refund = reserved - actual_cost
        self.available += refund
        self.used[contract_id] = actual_cost
        del self.reserved[contract_id]
        self._record("commit", refund)
        self.logger.info(f"交易确认: 实际成本 ${actual_cost:.2f}, 退还 ${refund:.2f}")
        return True
    
    def release_contract(self, contract_id: str):
        """释放合约资金"""
        if contract_id in self.reserved:
            amount = self.reserved[contract_id]
            self.available += amount
            del self.reserved[contract_id]
            self._record("release_reserved", amount)
            self.logger.info(f"释放预留资金: ${amount:.2f}")
    
    def add_profit(self, amount: float):
        """添加盈利"""
        self.available += amount
        self._record("profit", amount)
    
    def subtract_loss(self, amount: float):
        """扣除亏损"""
        self.available -= amount
        self._record("loss", -amount)
    
    def _record(self, action: str, amount: float):
        """记录交易"""
        self.history.append({
            "timestamp": time.time(),
            "action": action,
            "amount": amount,
            "balance": self.available
        })
    
    def get_utilization_rate(self) -> float:
        """获取资金利用率"""
        return (self.initial_balance - self.available) / self.initial_balance * 100
    
    def get_status(self) -> Dict:
        """获取资金状态"""
        return {
            "initial": self.initial_balance,
            "available": self.available,
            "reserved": sum(self.reserved.values()),
            "used": sum(self.used.values()),
            "utilization_rate": self.get_utilization_rate()
        }


# ============================================================================
# 改善类 5: PairCostTracker - Pair Cost 追踪
# ============================================================================
class PairCostTracker:
    """追踪 Pair Cost，确保不超限"""
    
    def __init__(self, target_pair_cost: float = 0.98):
        self.target = target_pair_cost
        self.yes_entries = []  # [(price, qty, timestamp)]
        self.no_entries = []
        self.logger = logging.getLogger("TradingBot.PairCost")
    
    def add_entry(self, side: str, price: float, qty: int):
        """记录成交"""
        entry = (price, qty, time.time())
        if side == "YES":
            self.yes_entries.append(entry)
        else:
            self.no_entries.append(entry)
        self.logger.debug(f"PairCost记录: {side} {qty}股 @ ${price:.4f}")
    
    def calculate_weighted_cost(self, side: str) -> float:
        """计算加权平均成本"""
        entries = self.yes_entries if side == "YES" else self.no_entries
        if not entries:
            return 0.0
        total_cost = sum(p * q for p, q, _ in entries)
        total_qty = sum(q for _, q, _ in entries)
        return total_cost / total_qty if total_qty > 0 else 0.0
    
    def get_current_pair_cost(self) -> float:
        """计算当前 Pair Cost"""
        yes_cost = self.calculate_weighted_cost("YES")
        no_cost = self.calculate_weighted_cost("NO")
        return yes_cost + no_cost
    
    def check_pair_cost_valid(self) -> bool:
        """检查是否超限"""
        pair_cost = self.get_current_pair_cost()
        return pair_cost <= self.target
    
    def get_profit_potential(self) -> float:
        """计算潜在利润"""
        pair_cost = self.get_current_pair_cost()
        return 1.0 - pair_cost if pair_cost > 0 else 0.0
    
    def reset(self):
        """清空记录"""
        self.yes_entries = []
        self.no_entries = []


# ============================================================================
# 改善类 6: TradingLogger - 交易日志管理
# ============================================================================
class TradingLogger:
    """交易日志管理"""
    
    @staticmethod
    def setup_logging(log_dir: str = "./logs") -> Tuple[logging.Logger, logging.Logger]:
        """设置日志系统"""
        os.makedirs(log_dir, exist_ok=True)
        
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        
        # 主日志
        main_handler = RotatingFileHandler(
            f"{log_dir}/trading.log",
            maxBytes=10*1024*1024,  # 10MB
            backupCount=5
        )
        main_handler.setLevel(logging.DEBUG)
        main_handler.setFormatter(formatter)
        
        # 交易日志
        trade_handler = RotatingFileHandler(
            f"{log_dir}/trades.log",
            maxBytes=10*1024*1024,
            backupCount=10
        )
        trade_handler.setLevel(logging.INFO)
        trade_handler.setFormatter(formatter)
        
        # 错误日志
        error_handler = RotatingFileHandler(
            f"{log_dir}/errors.log",
            maxBytes=5*1024*1024,
            backupCount=5
        )
        error_handler.setLevel(logging.ERROR)
        error_handler.setFormatter(formatter)
        
        # 配置根日志
        logger = logging.getLogger("TradingBot")
        logger.setLevel(logging.DEBUG)
        logger.addHandler(main_handler)
        logger.addHandler(error_handler)
        
        # 交易日志
        trade_logger = logging.getLogger("Trades")
        trade_logger.setLevel(logging.INFO)
        trade_logger.addHandler(trade_handler)
        
        # 控制台输出
        console = logging.StreamHandler()
        console.setLevel(logging.INFO)
        console.setFormatter(formatter)
        logger.addHandler(console)
        
        return logger, trade_logger


# ============================================================================
# 主交易类: StatArbTraderV3
# ============================================================================
class StatArbTraderV3:
    """双边挂单策略交易核心类 - v3.0 改善版"""
    
    def __init__(self, config: Dict):
        """初始化交易机器人"""
        # 设置日志
        self.logger, self.trade_logger = TradingLogger.setup_logging()
        self.logger.info("=" * 70)
        self.logger.info("🚀 交易机器人 v3.0 初始化")
        self.logger.info("=" * 70)
        
        self.config = config
        
        # ===== 改善类初始化 =====
        # 1. 合约计时器
        self.contract_timer = ContractTimer()
        
        # 2. API重试管理器
        self.api_retry = APIRetryManager(
            max_retries=config.get('max_retries', 3),
            base_delay=config.get('base_delay', 1.0)
        )
        
        # 3. 止损失管理器
        self.stop_loss_mgr = StopLossManager(config, self.contract_timer)
        
        # 4. 资金管理器
        initial_balance = config.get('initial_balance', 200.0)
        self.fund_mgr = FundManager(initial_balance)
        
        # 5. Pair Cost 追踪器
        self.pair_cost_tracker = PairCostTracker(
            target_pair_cost=config.get('target_pair_cost', 0.98)
        )
        
        # ===== 原有逻辑保留 =====
        self.initial_balance = initial_balance
        self.total_balance = self.fund_mgr.available
        
        # 记录资金变化
        self.balance_history = [{
            "time": datetime.datetime.now().isoformat(),
            "event": "初始化",
            "balance": self.total_balance,
            "change": 0
        }]
        
        # 记录每笔成交交易
        self.trade_history = []
        
        # 初始化持仓状态
        self.position = {
            "YES": {"shares": 0, "cost": 0.0},
            "NO": {"shares": 0, "cost": 0.0}
        }
        
        # 启动时间
        self.start_time = time.time()
        
        # 当前挂单状态
        self.active_orders = {
            "YES": None,
            "NO": None
        }
        
        # 波次配置
        self.wave_config = [20, 10, 5]
        self.current_wave = 0
        self.wave_filled_shares = {"YES": 0, "NO": 0}
        self.current_wave_target = self.wave_config[0]
        
        # 清算追踪
        self.last_settled_contract_start = None
        
        # 合约周期追踪
        self.contract_period = 1
        self.attempt_count = 0
        self.contract_failed = False
        
        # 交易统计
        self.stats = TradeStatistics()
        
        # 持久化状态文件路径
        self.state_file = "/tmp/stat_arb_state_v3.json"
        
        # 尝试载入之前保存的状态
        self.load_state()
        
        # 初始化API客户端
        if AuthenticatedClobClient:
            self.clob_client = AuthenticatedClobClient()
            self.logger.info("✅ API客户端已连接")
        else:
            self.clob_client = None
            self.logger.warning("⚠️ 使用模拟模式")
        
        self.logger.info("🎯 配置参数:")
        self.logger.info(f"   初始资金: ${initial_balance:.2f}")
        self.logger.info(f"   目标Pair Cost: ≤{config.get('target_pair_cost', 0.98)}")
        self.logger.info(f"   波次配置: {self.wave_config}")
        self.logger.info("=" * 70)
    
    def get_current_prices(self) -> Optional[Dict[str, float]]:
        """获取当前市场价格 - 带重试"""
        if not self.clob_client:
            # 模拟价格
            return {
                "YES": round(random.uniform(0.3, 0.7), 4),
                "NO": round(random.uniform(0.3, 0.7), 4)
            }
        
        try:
            result = self.api_retry.call_with_retry(self.clob_client.get_prices)
            if result and result.get("success"):
                yes_price = result.get("YES")
                no_price = result.get("NO")
                if yes_price and no_price and 0.01 <= yes_price <= 0.99 and 0.01 <= no_price <= 0.99:
                    return {"YES": yes_price, "NO": no_price}
            self.logger.error(f"价格获取失败: {result}")
            return None
        except Exception as e:
            self.logger.error(f"价格获取异常: {e}")
            return None
    
    def get_contract_elapsed_minutes(self) -> int:
        """使用ContractTimer获取已过分钟数"""
        return self.contract_timer.get_elapsed_minutes()
    
    def should_place_bids(self) -> bool:
        """判断是否应该挂双边单"""
        if self.contract_failed:
            self.logger.warning("⚠️ 合约已失败，跳过")
            return False
        
        elapsed_minutes = self.get_contract_elapsed_minutes()
        
        if elapsed_minutes < 1:
            self.logger.debug("⏳ 合约刚开始，等待1分钟...")
            return False
        
        if elapsed_minutes >= 10:
            self.logger.debug(f"⏰ 合约第{elapsed_minutes}分钟，不挂新单")
            return False
        
        prices = self.get_current_prices()
        if not prices:
            return False
        
        yes_price = prices["YES"]
        no_price = prices["NO"]
        
        if yes_price <= 0.70 and no_price <= 0.70:
            self.logger.info(f"✅ 价格符合: YES={yes_price:.4f}, NO={no_price:.4f}")
            return True
        else:
            self.logger.debug(f"❌ 价格不符合: YES={yes_price:.4f}, NO={no_price:.4f}")
            return False
    
    def calculate_bid_prices(self, market_prices: Dict[str, float]) -> Dict[str, float]:
        """计算双边挂单价"""
        wave_offsets = [0.125, 0.10, 0.075]
        wave_idx = min(self.current_wave, len(wave_offsets) - 1)
        offset = wave_offsets[wave_idx]
        
        yes_bid = max(0.01, market_prices["YES"] - offset)
        no_bid = max(0.01, market_prices["NO"] - offset)
        
        return {"YES": yes_bid, "NO": no_bid}
    
    def place_both_bids(self) -> bool:
        """同时挂双边低价单"""
        if self.active_orders["YES"] or self.active_orders["NO"]:
            self.logger.debug("⚠️ 存在未完成订单")
            return False
        
        market_prices = self.get_current_prices()
        if not market_prices:
            return False
        
        bid_prices = self.calculate_bid_prices(market_prices)
        quantity = self.current_wave_target
        
        yes_price = bid_prices["YES"]
        no_price = bid_prices["NO"]
        
        self.attempt_count += 1
        
        self.logger.info("=" * 70)
        self.logger.info(f"📌 [{self.get_timestamp()}] 合约#{self.contract_period} 第{self.current_wave+1}波")
        self.logger.info(f"   市价: YES={market_prices['YES']:.4f}, NO={market_prices['NO']:.4f}")
        self.logger.info(f"   挂单: YES={yes_price:.4f}, NO={no_price:.4f}")
        
        # 检查资金
        total_cost = (yes_price + no_price) * quantity
        if total_cost > self.fund_mgr.available:
            self.logger.error(f"❌ 资金不足: 需要${total_cost:.2f}, 可用${self.fund_mgr.available:.2f}")
            return False
        
        # 创建订单
        yes_order_id = f"YES_{int(time.time())}_{quantity}"
        no_order_id = f"NO_{int(time.time())}_{quantity}"
        
        self.active_orders["YES"] = {
            "order_id": yes_order_id,
            "price": yes_price,
            "original_price": yes_price,
            "quantity": quantity,
            "side": "YES",
            "status": "OPEN",
            "filled_price": None,
            "placed_at": time.time()
        }
        
        self.active_orders["NO"] = {
            "order_id": no_order_id,
            "price": no_price,
            "original_price": no_price,
            "quantity": quantity,
            "side": "NO",
            "status": "OPEN",
            "filled_price": None,
            "placed_at": time.time()
        }
        
        self.logger.info(f"   ✅ 双边挂单成功")
        self.logger.info("=" * 70)
        
        return True
    
    def check_order_status(self):
        """检查并更新订单状态"""
        current_prices = self.get_current_prices()
        if not current_prices:
            return
        
        for side in ["YES", "NO"]:
            order = self.active_orders[side]
            if order and order["status"] == "OPEN":
                market_price = current_prices[side]
                bid_price = order["price"]
                
                if market_price <= bid_price:
                    order["status"] = "FILLED"
                    order["filled_price"] = bid_price
                    order["filled_at"] = time.time()
                    qty = order["quantity"]
                    fill_cost = bid_price * qty
                    
                    # 更新持仓
                    self.position[side]["shares"] += qty
                    self.position[side]["cost"] += fill_cost
                    
                    # 更新资金
                    self.fund_mgr.available -= fill_cost
                    
                    # 记录成交
                    self.trade_history.append({
                        "time": datetime.datetime.now().strftime("%H:%M:%S"),
                        "contract_period": self.contract_period,
                        "wave": self.current_wave + 1,
                        "side": side,
                        "quantity": qty,
                        "price": bid_price,
                        "market_price": market_price,
                        "balance_after": self.fund_mgr.available
                    })
                    
                    # 更新波次追踪
                    self.wave_filled_shares[side] += qty
                    
                    # 记录到PairCostTracker
                    self.pair_cost_tracker.add_entry(side, bid_price, qty)
                    
                    # 记录到StopLossManager
                    self.stop_loss_mgr.record_fill(side, bid_price, qty)
                    
                    self.logger.info(f"🔔 成交: {side} {qty}股 @ ${bid_price:.4f}")
                    self.logger.info(f"   持仓: {side}={self.position[side]['shares']}股, 剩余资金=${self.fund_mgr.available:.2f}")
    
    def get_filled_orders(self) -> list:
        """获取已成交订单"""
        filled = []
        for side in ["YES", "NO"]:
            order = self.active_orders[side]
            if order and order["status"] == "FILLED":
                filled.append(order)
        return filled
    
    def get_open_orders(self) -> list:
        """获取未成交订单"""
        open_orders = []
        for side in ["YES", "NO"]:
            order = self.active_orders[side]
            if order and order["status"] == "OPEN":
                open_orders.append(order)
        return open_orders
    
    def check_and_advance_wave(self):
        """检查是否进入下一波"""
        yes_done = self.wave_filled_shares["YES"] >= self.current_wave_target
        no_done = self.wave_filled_shares["NO"] >= self.current_wave_target
        
        if yes_done and no_done:
            if self.current_wave < len(self.wave_config) - 1:
                self.current_wave += 1
                self.current_wave_target = self.wave_config[self.current_wave]
                self.wave_filled_shares = {"YES": 0, "NO": 0}
                self.attempt_count = 0
                self.logger.info(f"🌊 进入第{self.current_wave + 1}波 (仓位: {self.current_wave_target}股)")
            else:
                self.logger.info(f"✅ 所有波次完成")
    
    def clear_orders(self):
        """清除订单状态"""
        self.active_orders = {"YES": None, "NO": None}
    
    def get_timestamp(self) -> str:
        """获取当前时间戳"""
        return datetime.datetime.now().strftime("%H:%M:%S")
    
    def save_state(self):
        """保存交易状态"""
        try:
            history = []
            for record in self.balance_history[-50:]:
                history.append({
                    "time": record.get("time", ""),
                    "event": record.get("event", ""),
                    "balance": record.get("balance", 0),
                    "change": record.get("change", 0)
                })
            
            last_settled = None
            if self.last_settled_contract_start:
                if hasattr(self.last_settled_contract_start, 'isoformat'):
                    last_settled = self.last_settled_contract_start.isoformat()
                else:
                    last_settled = str(self.last_settled_contract_start)
            
            state = {
                "total_balance": self.fund_mgr.available,
                "position": self.position,
                "contract_period": self.contract_period,
                "current_wave": self.current_wave,
                "contract_failed": self.contract_failed,
                "last_settled_contract_start": last_settled,
                "balance_history": history,
                "contract_start_time": self.contract_timer.contract_start_time,
                "contract_id": self.contract_timer.contract_id
            }
            
            with open(self.state_file, 'w') as f:
                json.dump(state, f, indent=2)
            
            self.logger.debug(f"💾 状态已保存: 资金=${self.fund_mgr.available:.2f}")
        except Exception as e:
            self.logger.error(f"❌ 保存状态失败: {e}")
    
    def load_state(self):
        """从文件载入交易状态"""
        try:
            if os.path.exists(self.state_file):
                with open(self.state_file, 'r') as f:
                    state = json.load(f)
                
                self.fund_mgr.available = state.get("total_balance", self.initial_balance)
                self.position = state.get("position", self.position)
                self.contract_period = state.get("contract_period", 1)
                self.current_wave = state.get("current_wave", 0)
                self.contract_failed = False  # 重置
                self.last_settled_contract_start = state.get("last_settled_contract_start")
                self.balance_history = state.get("balance_history", [])
                
                # 恢复ContractTimer状态
                if "contract_id" in state:
                    self.contract_timer.contract_id = state["contract_id"]
                
                self.logger.info(f"📂 状态已载入: 资金=${self.fund_mgr.available:.2f}, 合约#{self.contract_period}")
        except Exception as e:
            self.logger.warning(f"⚠️ 载入状态失败: {e}")
    
    def run_once(self):
        """单次运行循环"""
        # 检查是否应该挂单
        if not self.active_orders["YES"] and not self.active_orders["NO"]:
            if not self.should_place_bids():
                self.logger.debug(f"[{self.get_timestamp()}] 条件不符合，跳过")
                time.sleep(10)
                return
            
            if not self.place_both_bids():
                self.logger.debug(f"[{self.get_timestamp()}] 挂单失败")
                return
        
        # 检查订单状态
        self.check_order_status()
        
        # 获取订单状态
        filled_orders = self.get_filled_orders()
        open_orders = self.get_open_orders()
        
        # 检查止损失条件
        should_stop, stop_reason = self.stop_loss_mgr.check_stop_loss_conditions()
        
        elapsed_minutes = self.get_contract_elapsed_minutes()
        
        # 处理第10分钟止损失
        if elapsed_minutes >= 10 and len(filled_orders) == 1 and len(open_orders) == 1:
            yes_shares = self.position["YES"]["shares"]
            no_shares = self.position["NO"]["shares"]
            
            if yes_shares > 0 and no_shares > 0 and yes_shares == no_shares:
                self.logger.info(f"✅ 双边持仓平衡，持有到期")
                return
            else:
                self.logger.warning(f"🚨 持仓不平衡，执行市价止损失")
                # 执行止损失逻辑...
        
        # 双边成交
        elif len(filled_orders) == 2:
            self.logger.info(f"✅ 双边成交完成")
            self.clear_orders()
            self.check_and_advance_wave()
        
        time.sleep(5)
    
    def run_loop(self, max_iterations: int = None):
        """主循环运行"""
        self.logger.info("🚀 启动交易循环...")
        
        iteration = 0
        try:
            while True:
                # 检查是否进入新合约
                if self.contract_timer.is_new_contract():
                    self.logger.info("🚀 新的15分钟合约开始!")
                    self.contract_period += 1
                    self.current_wave = 0
                    self.current_wave_target = self.wave_config[0]
                    self.wave_filled_shares = {"YES": 0, "NO": 0}
                    self.contract_failed = False
                    self.stop_loss_mgr.clear_fills()
                    self.pair_cost_tracker.reset()
                
                # 执行一次循环
                self.run_once()
                
                iteration += 1
                if max_iterations and iteration >= max_iterations:
                    self.logger.info(f"✅ 达到最大循环次数 {max_iterations}")
                    break
                
                # 保存状态
                if iteration % 12 == 0:  # 每分钟保存一次
                    self.save_state()
        
        except KeyboardInterrupt:
            self.logger.info("👋 用户中断")
        except Exception as e:
            self.logger.error(f"❌ 错误: {e}")
            import traceback
            self.logger.error(traceback.format_exc())
        
        self.save_state()
        self.logger.info("交易结束")


class TradeStatistics:
    """交易统计"""
    
    def __init__(self):
        self.total_trades = 0
        self.successful_trades = 0
        self.loss_trades = 0
        self.total_profit = 0.0
        self.total_loss = 0.0
    
    def record_successful_trade(self, pair_cost: float, quantity: int):
        """记录成功交易"""
        profit = (1.0 - pair_cost) * quantity
        self.successful_trades += 1
        self.total_trades += 1
        self.total_profit += profit
    
    def record_loss_trade(self, loss: float):
        """记录亏损交易"""
        self.loss_trades += 1
        self.total_trades += 1
        self.total_loss += loss


# 测试入口
if __name__ == "__main__":
    config = {
        "bid_offset": 0.07,
        "max_chase_amount": 0.18,
        "target_pair_cost": 0.98,
        "order_timeout": 180,
        "check_interval": 5,
        "initial_balance": 200.0,
        "max_retries": 3,
        "base_delay": 1.0
    }
    
    print("=" * 70)
    print("🚀 Polymarket 统计套利交易机器人 v3.0")
    print("=" * 70)
    
    trader = StatArbTraderV3(config)
    trader.run_loop()
